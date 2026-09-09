/**
 * Приёмник событий.
 *
 * Идентификатор игрока не ездит в событиях вовсе: клиент всё равно не может
 * его доказать, а принимать на слово нельзя — тогда кто угодно нальёт событий
 * от чужого имени. Поэтому личность устанавливается один раз, при открытии
 * сессии, по подписи параметров запуска, а дальше ездит только наш случайный
 * `session_id`.
 *
 * Проверку подписи приёмник не делает сам: она своя у каждой площадки, а
 * пакету положено не знать про ВКонтакте ничего. Функция `verify` внедряется
 * снаружи.
 */
import { randomBytes } from 'node:crypto';

import { validate } from '../schema.mjs';
import { anonSubject, playerSubject } from './identity.mjs';

const MAX_BATCH = 100;
const MAX_SESSION_EVENTS = 5000;

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const token = () => randomBytes(16).toString('base64url');
const bounded = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

export function createReceiver({
  sink, key, keyVersion = 1, apps, verify, now = Date.now,
}) {
  const allowed = new Set(apps);
  // Счётчик событий на сессию держится в памяти: он нужен только чтобы
  // остановить поток, а после перезапуска поток и так начнётся заново.
  const counts = new Map();
  // Серверные события живут в псевдосессии — по одной на приложение. Так они
  // ложатся в ту же таблицу и считаются теми же запросами, а не заводят
  // второй путь записи ради семи событий в сутки.
  const serverSessions = new Map();

  function serverSession(app) {
    let id = serverSessions.get(app);
    if (id) return id;
    id = token();
    const at = now();
    sink.session({
      session_id: id, app, subject_id: 'server', anon_subject: 'server',
      key_version: keyVersion, platform: 'server', verified: 1,
      app_version: null, language: null, os: null, mobile: null, screen: null,
      entry: 'server', day: dayKey(at), started_at: at, last_seen_at: at,
    });
    serverSessions.set(app, id);
    return id;
  }

  return {
    session(body) {
      const app = bounded(body?.app, 64);
      const anonId = bounded(body?.anon_id, 64);
      if (!app || !allowed.has(app)) return { status: 400, body: { error: 'app' } };
      if (!anonId) return { status: 400, body: { error: 'anon_id' } };

      const checked = (body.launch && verify(body.launch)) || { ok: false };
      const anon = anonSubject(anonId, key);
      const platform = checked.ok ? checked.platform : 'local';
      const subjectId = checked.ok ? playerSubject(platform, checked.playerId, key) : anon;

      const ctx = body.ctx ?? {};
      const at = now();
      const id = token();
      sink.session({
        session_id: id, app, subject_id: subjectId, anon_subject: anon,
        key_version: keyVersion, platform, verified: checked.ok ? 1 : 0,
        app_version: bounded(ctx.app_version, 40),
        language: bounded(ctx.language, 8),
        os: bounded(ctx.os, 16),
        mobile: ctx.mobile ? 1 : 0,
        screen: bounded(ctx.screen, 4),
        entry: bounded(ctx.entry, 16),
        day: dayKey(at), started_at: at, last_seen_at: at,
      });
      return { status: 200, body: { session_id: id } };
    },

    collect(body) {
      // Приём отвечает успехом почти всегда. Ошибка заставила бы клиент
      // повторять пачку вечно, а ценность одной пачки этого не стоит.
      const sessionId = bounded(body?.s, 40);
      const list = Array.isArray(body?.e) ? body.e : [];
      if (!sessionId || list.length === 0) return { status: 204 };

      const seen = counts.get(sessionId) ?? 0;
      if (seen >= MAX_SESSION_EVENTS) return { status: 204 };

      const receivedAt = now();
      // Часы на мобильных врут регулярно. Без поправки событие с телефона с
      // неверной датой попадёт в чужой день и испортит суточный срез.
      const sentAt = Number.isFinite(body?.sent_at) ? body.sent_at : receivedAt;
      const skew = receivedAt - sentAt;

      const rows = [];
      for (const item of list.slice(0, MAX_BATCH)) {
        const name = bounded(item?.n, 64);
        const seq = Number.isInteger(item?.q) ? item.q : null;
        if (!name || seq === null) continue;
        const clientTs = Number.isFinite(item?.t) ? item.t : sentAt;
        const { known, props } = validate(name, item?.p);
        rows.push({
          session_id: sessionId, seq, name,
          ts: clientTs + skew, received_at: receivedAt, day: dayKey(clientTs + skew),
          props: JSON.stringify(props), known: known ? 1 : 0,
        });
      }

      try {
        const written = sink.events(rows);
        counts.set(sessionId, seen + written);
      } catch (error) {
        // Упавшая пачка теряется и остаётся в журнале. Процесс, который
        // принимает деньги, не должен падать из-за статистики.
        console.error('[аналитика] пачка не записана', error);
      }
      return { status: 204 };
    },

    /** Событие, о котором знает только сервер: начисление, отказ по подписи. */
    track(app, name, props) {
      if (!allowed.has(app)) return;
      const id = serverSession(app);
      const at = now();
      const { known, props: clean } = validate(name, props);
      const seq = (counts.get(id) ?? 0) + 1;
      counts.set(id, seq);
      try {
        sink.events([{
          session_id: id, seq, name, ts: at, received_at: at,
          day: dayKey(at), props: JSON.stringify(clean), known: known ? 1 : 0,
        }]);
      } catch (error) {
        console.error('[аналитика] серверное событие не записано', error);
      }
    },
  };
}
