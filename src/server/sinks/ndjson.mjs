/**
 * Запасной приёмник: строка JSON на событие.
 *
 * Нужен по двум поводам. Первый — отладка: файл читается глазами и `jq`, а
 * база требует запроса. Второй важнее — он доказывает, что интерфейс sink не
 * протёк подробностями SQLite. Если второй приёмник написать нельзя, значит и
 * переезд на другое хранилище будет не заменой строки, а переписыванием.
 */
import { openSync, writeSync, closeSync } from 'node:fs';

export function createNdjsonSink(path) {
  const fd = openSync(path, 'a');
  const line = (record) => writeSync(fd, `${JSON.stringify(record)}\n`);

  return {
    session(row) {
      line({ kind: 'session', ...row });
    },
    events(rows) {
      for (const row of rows) line({ kind: 'event', ...row });
      return rows.length;
    },
    close() {
      closeSync(fd);
    },
  };
}
