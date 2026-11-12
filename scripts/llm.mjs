#!/usr/bin/env node
/**
 * Mostek do centralnego wyboru modelu dla skryptów w innym języku i dla shella.
 *
 * Wejście: JSON na stdin `{"prompt": "...", "system": "...", "maxTokens": 400,
 * "temperature": 0.1, "models": "groq:openai/gpt-oss-120b"}` (wszystko poza
 * `prompt` opcjonalne). Wyjście: JSON `{"text", "provider", "model"}`; z flagą
 * `--json` dochodzi sparsowane `data`.
 *
 *   node scripts/llm.mjs --models            # co wejdzie do losowania
 *   node scripts/llm.mjs --models --all      # razem z modelami na karencji
 *   echo '{"prompt":"..."}' | node scripts/llm.mjs --json
 */
import { ask, describeCandidates, parseJson } from './lib/llm.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    index += 1;
  } else args.set(token.slice(2), 'true');
}

const readStdin = async () => {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
};

if (args.has('models')) {
  const list = await describeCandidates({
    models: args.get('model') ?? '',
    includeCooling: args.has('all'),
  });
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}

const raw = await readStdin();
if (!raw) {
  console.error('Brak wejścia: podaj JSON {"prompt": "..."} na stdin.');
  process.exit(1);
}

let input;
try {
  input = JSON.parse(raw);
} catch (error) {
  console.error(`Wejście nie jest JSON-em: ${error.message}`);
  process.exit(1);
}

if (!input.prompt) {
  console.error('Brak pola "prompt".');
  process.exit(1);
}

try {
  const answer = await ask(input.prompt, {
    system: input.system ?? args.get('system') ?? '',
    maxTokens: Number(input.maxTokens ?? args.get('max-tokens') ?? 0) || undefined,
    temperature: Number(input.temperature ?? args.get('temperature') ?? 0.2),
    models: input.models ?? args.get('model') ?? '',
    timeoutMs: Number(input.timeoutMs ?? 0) || undefined,
  });
  const result = { text: answer.text, provider: answer.provider, model: answer.model };
  if (args.has('json')) result.data = parseJson(answer.text);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
