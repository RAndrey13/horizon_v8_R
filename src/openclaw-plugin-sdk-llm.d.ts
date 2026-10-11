// OpenClaw 9.3 (как и 9.1) поставляет dist/plugin-sdk/llm.js БЕЗ парного llm.d.ts,
// поэтому tsc дает TS7016 на импорте этого подпути. Объявляем модуль локально.
// Тип возврата any: SDK типов для этого подпути не поставляет вовсе.
declare module "openclaw/plugin-sdk/llm" {
  export function createAssistantMessageEventStream(): any;
}
