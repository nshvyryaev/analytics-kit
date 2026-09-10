import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteSink, openAnalyticsDb } from '../src/server/sinks/sqlite.mjs';
import { prune, rollup } from '../src/server/rollup.mjs';

const DAY = '2026-09-09';

function filled() {
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  for (const [id, subject] of [['с1', 'ПС1'], ['с2', 'ПС2'], ['с3', 'ПС1']]) {
    sink.session({
      session_id: id, app: 'word-chain', subject_id: subject, anon_subject: subject,
      key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
      os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
      started_at: 1000, last_seen_at: 1000,
    });
  }
  sink.events([
    { session_id: 'с1', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved","length":5}', known: 1 },
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"abandoned","length":5}', known: 1 },
  ]);
  sink.events([
    { session_id: 'с2', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved","length":5}', known: 1 },
  ]);
  return db;
}

const metric = (db, name) =>
  db.prepare('SELECT value FROM daily WHERE app = ? AND day = ? AND metric = ?')
    .get('word-chain', DAY, name)?.value;

test('свёртка считает игроков за день, а не сессии', () => {
  const db = filled();
  rollup(db, DAY);
  assert.equal(metric(db, 'dau'), 2);
  assert.equal(metric(db, 'sessions'), 3);
  db.close();
});

test('свёртка разбивает событие по исходу и длине', () => {
  const db = filled();
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved:5'), 2);
  assert.equal(metric(db, 'level_end:abandoned:5'), 1);
  db.close();
});

test('повторная свёртка того же дня не задваивает', () => {
  const db = filled();
  rollup(db, DAY);
  rollup(db, DAY);
  assert.equal(metric(db, 'dau'), 2);
  db.close();
});

test('свёртка обновляет счётчик побед у игрока', () => {
  const db = filled();
  rollup(db, DAY);
  const row = db.prepare('SELECT levels_won FROM subjects WHERE subject_id = ?').get('ПС1');
  assert.equal(row.levels_won, 1);
  db.close();
});

test('отсечка убирает сырьё, но оставляет игроков и активность', () => {
  const db = filled();
  rollup(db, DAY);
  const removed = prune(db, { before: '2026-10-10' });
  assert.ok(removed.events > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 2);
  assert.equal(metric(db, 'dau'), 2);
  db.close();
});

test('счётчик побед не проседает при повторной свёртке после отсечки старого дня', () => {
  // Регрессия: прежний пересчёт levels_won читал COUNT(*) прямо из events без
  // ограничения по дню. Это не ловится свёрткой одного дня и уж тем более не
  // ловится вызовом prune() самим по себе — prune никогда не трогал subjects,
  // поэтому "свернуть — отсечь — проверить, что не изменилось" проходит
  // одинаково что на старом, что на новом коде и ничего не доказывает. Баг
  // проявляется только на СЛЕДУЮЩЕЙ свёртке ПОСЛЕ отсечки: пересчёт берёт
  // COUNT по уже урезанному events и теряет победы из отсечённых дней.
  const OLD_DAY = '2026-08-01';
  const NEW_DAY = '2026-09-09';
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  const session = (id, day) => ({
    session_id: id, app: 'word-chain', subject_id: 'ПС1', anon_subject: 'ПС1',
    key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
    os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.session(session('старая', OLD_DAY));
  sink.session(session('свежая', NEW_DAY));
  sink.events([
    { session_id: 'старая', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: OLD_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);
  sink.events([
    { session_id: 'свежая', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: NEW_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);

  // 1-2. Победа в старый день и победа в свежий — сворачиваем оба дня.
  rollup(db, OLD_DAY);
  rollup(db, NEW_DAY);
  const total = () => db.prepare('SELECT levels_won FROM subjects WHERE subject_id = ?').get('ПС1').levels_won;
  assert.equal(total(), 2);

  // 3. Отсекаем сырьё так, чтобы старый день ушёл, а свежий остался.
  const removed = prune(db, { before: NEW_DAY });
  assert.ok(removed.events > 0);

  // 4-5. Свёртка свежего дня ЕЩЁ РАЗ, уже после отсечки старого — счётчик
  // должен остаться 2, а не просесть до 1 из-за потери отсечённой победы.
  rollup(db, NEW_DAY);
  assert.equal(total(), 2);
  db.close();
});

test('отсечка не роняется на долгоживущей сессии со свежими событиями', () => {
  // Воспроизводит гарантию, а не край: серверная псевдосессия (до фикса
  // на суточный ключ) заводится раз на процесс с фиксированным `day` и
  // пишет события каждый день, пока процесс жив; то же с любой клиентской
  // сессией, начатой до полуночи. У такой сессии `day` уходит за границу
  // отсечки, а события — нет: наивное "DELETE events WHERE day < before,
  // потом DELETE sessions WHERE day < before" пытается удалить сессию, на
  // которую всё ещё ссылаются свежие события, и падает на внешнем ключе
  // (PRAGMA foreign_keys = ON). Тест должен падать на нынешнем коде.
  const OLD_DAY = '2026-08-01';
  const CUTOFF = '2026-09-01';
  const FRESH_DAY = '2026-09-05';
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session({
    session_id: 'долгая', app: 'word-chain', subject_id: 'server', anon_subject: 'server',
    key_version: 1, platform: 'server', verified: 1, app_version: null, language: null,
    os: null, mobile: null, screen: null, entry: 'server', day: OLD_DAY,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.events([
    { session_id: 'долгая', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: OLD_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);
  sink.events([
    { session_id: 'долгая', seq: 2, name: 'level_end', ts: 2, received_at: 2, day: FRESH_DAY, props: '{"outcome":"solved"}', known: 1 },
  ]);

  const removed = prune(db, { before: CUTOFF });

  assert.equal(removed.events, 1);
  assert.equal(removed.sessions, 0);
  assert.ok(db.prepare('SELECT 1 AS found FROM sessions WHERE session_id = ?').get('долгая'));
  assert.ok(db.prepare('SELECT 1 AS found FROM events WHERE session_id = ? AND seq = 2').get('долгая'));
  db.close();
});

test('свёртка включает длину слова в имя метрики уровня', () => {
  // I5: главный вопрос трека — на какой длине слова игра ломается — не
  // отвечается метрикой без длины. level_end разбивается по исходу И длине,
  // level_start — по длине (у него исхода нет вовсе).
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session({
    session_id: 'с1', app: 'word-chain', subject_id: 'ПС1', anon_subject: 'ПС1',
    key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
    os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.events([
    { session_id: 'с1', seq: 1, name: 'level_start', ts: 1, received_at: 1, day: DAY, props: '{"mode":"puzzle","length":5,"level":1,"resumed":false}', known: 1 },
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 2, received_at: 2, day: DAY, props: '{"outcome":"solved","length":5}', known: 1 },
  ]);
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved:5'), 1);
  assert.equal(metric(db, 'level_start:5'), 1);
  // Старое имя без длины больше не пишется.
  assert.equal(metric(db, 'level_end:solved'), undefined);
  db.close();
});

test('свёртка на нескольких сотнях событий не грузит сырьё дважды и не зависит от порядка обхода', () => {
  // I7: раньше props группировались в SQL (бессмысленно — они почти
  // уникальны на level_end/word_rejected) и читались заново вторым запросом
  // ради подневных счётчиков игрока. Проверяем, что цифры совпадают с тем,
  // что дало бы прежнее поведение, и что порядок вставки событий (и,
  // соответственно, порядок обхода курсора) не меняет итоговые суммы.
  const build = (order) => {
    const db = openAnalyticsDb(':memory:');
    const sink = createSqliteSink(db);
    for (const [id, subject] of [['с1', 'ПС1'], ['с2', 'ПС2'], ['с3', 'ПС1']]) {
      sink.session({
        session_id: id, app: 'word-chain', subject_id: subject, anon_subject: subject,
        key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
        os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
        started_at: 1000, last_seen_at: 1000,
      });
    }
    const sessions = ['с1', 'с2', 'с3'];
    const events = [];
    let seqBySession = { с1: 0, с2: 0, с3: 0 };
    for (let i = 0; i < 300; i += 1) {
      const session = sessions[i % sessions.length];
      seqBySession[session] += 1;
      const length = 3 + (i % 6);
      const outcome = i % 3 === 0 ? 'abandoned' : 'solved';
      events.push({
        session_id: session, seq: seqBySession[session], name: 'level_end',
        ts: i, received_at: i, day: DAY,
        // moves делает props почти уникальными на каждое событие — как в
        // реальных данных, ради которых прежний GROUP BY props ничего не
        // склеивал.
        props: JSON.stringify({ outcome, length, moves: [i, i + 1, i + 2] }),
        known: 1,
      });
    }
    const ordered = order === 'reversed' ? [...events].reverse() : events;
    for (const event of ordered) sink.events([event]);
    rollup(db, DAY);
    return db;
  };

  const forward = build('forward');
  const reversed = build('reversed');

  const byLengthOutcome = (db, length, outcome) => metric(db, `level_end:${outcome}:${length}`);
  for (let length = 3; length < 9; length += 1) {
    for (const outcome of ['solved', 'abandoned']) {
      assert.equal(byLengthOutcome(forward, length, outcome), byLengthOutcome(reversed, length, outcome));
    }
  }

  // Победы у ПС1 (сессии с1 и с3) должны совпасть между прогонами и быть
  // посчитаны верно — проверяем итоговую сумму, а не только равенство между
  // прогонами, чтобы поймать регрессию, одинаково сломанную в обоих.
  const won = (db) => db.prepare('SELECT levels_won FROM subjects WHERE subject_id = ?').get('ПС1').levels_won;
  assert.equal(won(forward), won(reversed));
  assert.ok(won(forward) > 0);

  forward.close();
  reversed.close();
});

test('серверная сессия, привязанная к игроку, не засоряет аудиторию', () => {
  // Замечание 1 (круг 2): серверная псевдосессия покупки заводится с
  // НАСТОЯЩЕЙ площадкой игрока (не 'server' — см. receiver.mjs,
  // playerServerSession), поэтому отличить её от обычной клиентской сессии
  // по платформе больше нельзя. Отличает `entry = 'server'`. Без фильтра по
  // нему отложенный платёжный колбёк игрока, который сегодня не заходил,
  // добавил бы и sessions, и присутствие в dau — воспроизводим ровно тот
  // прогон, что дал ревьюер: три живых сессии плюс один такой колбэк должны
  // дать dau = 3, sessions = 3, а не 4/4.
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  for (const [id, subject] of [['с1', 'ИГ1'], ['с2', 'ИГ2'], ['с3', 'ИГ3']]) {
    sink.session({
      session_id: id, app: 'word-chain', subject_id: subject, anon_subject: subject,
      key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
      os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
      started_at: 1000, last_seen_at: 1000,
    });
  }
  // Игрок ИГ4 сегодня не заходил — только прислал отложенный платёжный
  // колбэк. Сессия — серверная, площадка настоящая (vk), как заводит
  // playerServerSession в receiver.mjs.
  sink.session({
    session_id: 'с4', app: 'word-chain', subject_id: 'ИГ4', anon_subject: 'ИГ4',
    key_version: 1, platform: 'vk', verified: 1, app_version: null, language: null,
    os: null, mobile: null, screen: null, entry: 'server', day: DAY,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.events([
    { session_id: 'с4', seq: 1, name: 'purchase_credited', ts: 1, received_at: 1, day: DAY, props: '{"source":"vk","hints":10}', known: 1 },
  ]);

  rollup(db, DAY);
  assert.equal(metric(db, 'dau'), 3);
  assert.equal(metric(db, 'sessions'), 3);

  // subjects.sessions у ИГ4 тоже не растёт от покупки.
  const subject = db.prepare('SELECT sessions FROM subjects WHERE subject_id = ?').get('ИГ4');
  assert.equal(subject.sessions, 0);

  // А подневный счётчик покупок в activity всё равно заполняется — ради
  // этого привязка и делалась. Цена решения (см. комментарий в
  // rollup.mjs/sqlite.mjs): день, в который игрок только купил, засчитан
  // активным (строка activity существует).
  const activity = db.prepare('SELECT hints_bought FROM activity WHERE app = ? AND day = ? AND subject_id = ?')
    .get('word-chain', DAY, 'ИГ4');
  assert.ok(activity);
  assert.equal(activity.hints_bought, 10);
  db.close();
});

test('длина слова вне диапазона не создаёт строку в daily, допустимая — создаёт', () => {
  // Замечание 2 (круг 2): rollup держит собственную независимую проверку
  // диапазона длины (isWordLength в rollup.mjs), а не полагается только на
  // словарь (schema.mjs). Пишем событие с length вне диапазона НАПРЯМУЮ через
  // sink, в обход validate() из schema.mjs — так же, как выглядела бы база,
  // если бы словарь когда-нибудь смягчили или в ней осталось сырьё, записанное
  // до ужесточения. Мощность `daily` (таблицы без ретеншена) не должна
  // зависеть от того, что когда-то попало в props.
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session({
    session_id: 'с1', app: 'word-chain', subject_id: 'ПС1', anon_subject: 'ПС1',
    key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
    os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.events([
    { session_id: 'с1', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"outcome":"solved","length":99}', known: 1 },
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 2, received_at: 2, day: DAY, props: '{"outcome":"solved","length":5}', known: 1 },
  ]);
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved:99'), undefined);
  assert.equal(metric(db, 'level_end:solved:5'), 1);
  // Событие с length вне диапазона всё равно посчитано — просто без суффикса
  // длины (см. следующий тест про неоднозначность).
  assert.equal(metric(db, 'level_end'), 1);
  db.close();
});

test('частичные измерения не дают неоднозначный суффикс', () => {
  // Замечание 3 (круг 2): level_end без исхода (например, клиент его не
  // прислал) и с length = 6 не должен давать "level_end:6" — по форме это
  // неотличимо от «второго измерения не было, значит 6 — единственное».
  // Суффикс собирается только когда ВСЕ измерения события валидны; если
  // хоть одного нет — метрика остаётся голым именем события.
  const db = openAnalyticsDb(':memory:');
  const sink = createSqliteSink(db);
  sink.session({
    session_id: 'с1', app: 'word-chain', subject_id: 'ПС1', anon_subject: 'ПС1',
    key_version: 1, platform: 'vk', verified: 1, app_version: 'abc', language: 'ru',
    os: 'android', mobile: 1, screen: 'sm', entry: 'direct', day: DAY,
    started_at: 1000, last_seen_at: 1000,
  });
  sink.events([
    // outcome отсутствует вовсе.
    { session_id: 'с1', seq: 1, name: 'level_end', ts: 1, received_at: 1, day: DAY, props: '{"length":6}', known: 1 },
    // outcome неверного типа (замечание 4 заодно — тип проверяется, а не
    // просто "значение есть").
    { session_id: 'с1', seq: 2, name: 'level_end', ts: 2, received_at: 2, day: DAY, props: '{"outcome":123,"length":6}', known: 1 },
  ]);
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:6'), undefined);
  assert.equal(metric(db, 'level_end:123:6'), undefined);
  assert.equal(metric(db, 'level_end'), 2);
  db.close();
});

test('незнакомое событие не подделывает метрику по исходу', () => {
  // Событие с именем, буквально равным составному ключу метрики, но пришедшее
  // как незнакомое (known = 0), не должно сливаться с настоящей агрегацией
  // по исходу — иначе клиент подделывает деловую метрику мимо словаря.
  const db = filled();
  const sink = createSqliteSink(db);
  sink.events([
    { session_id: 'с1', seq: 3, name: 'level_end:solved', ts: 1, received_at: 1, day: DAY, props: '{}', known: 0 },
  ]);
  rollup(db, DAY);
  assert.equal(metric(db, 'level_end:solved:5'), 2);
  assert.equal(metric(db, 'level_end:solved'), undefined);
  assert.equal(metric(db, 'events_unknown'), 1);
  db.close();
});
