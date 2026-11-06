// Scripted local provider for tests, copied from pi-agora experiments/p0/harness/fake-provider.ts.
// pi loads it with -e; it never contacts a model service.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
} from '@earendil-works/pi-ai/compat';

function json(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
    if (item instanceof AbortSignal) return { aborted: item.aborted };
    return item;
  });
}

function readRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function lastUserText(messages) {
  const user = messages.findLast((message) => message.role === 'user');
  if (typeof user?.content === 'string') return user.content;
  return user?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? '';
}

function selectReply(script, request, text) {
  const route = script.routes?.find(({ when = {} }) =>
    (when.request === undefined || when.request === request) &&
    (when.lastUser === undefined || when.lastUser === text) &&
    (when.includes === undefined || text.includes(when.includes)) &&
    (when.regex === undefined || new RegExp(when.regex).test(text)));
  const reply = route?.reply ?? script.turns?.[request - 1] ?? script.fallback;
  if (!reply) throw new Error(`P0 script exhausted at provider request ${request}`);
  return reply;
}

function usageOf(usage = {}) {
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage };
  result.totalTokens ??= result.input + result.output + result.cacheRead + result.cacheWrite;
  result.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...usage.cost };
  return result;
}

export default function (pi) {
  const scriptPath = process.env.FAKE_SCRIPT_PATH;
  const logPath = process.env.FAKE_REQUEST_LOG;
  if (!scriptPath || !logPath) throw new Error('FAKE_SCRIPT_PATH and FAKE_REQUEST_LOG are required');
  const log = (entry) => appendFileSync(logPath, `${json({ timestamp: new Date().toISOString(), ...entry })}\n`);

  pi.registerProvider('p0-fake', {
    baseUrl: 'http://127.0.0.1:1/never-requested',
    apiKey: 'p0-local-not-a-secret',
    api: 'p0-scripted',
    models: [{
      id: 'scripted', name: 'P0 scripted local provider', reasoning: true,
      input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 8192,
    }],
    streamSimple(model, context, options = {}) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: 'pending', usage: usageOf(),
      };
      const request = readRecords(logPath).filter((entry) => entry.kind === 'request').length + 1;
      const text = lastUserText(context.messages);
      const onAbort = () => log({ kind: 'abort_received', request });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Snapshot synchronously so caller mutations cannot change logged block ordering.
      log({ kind: 'request', request, model, context, options,
        tools: getCurrentTools(context.messages),
        systemPrompt: getCurrentSystemPrompt(context.messages), lastUser: text,
      });

      (async () => {
        let ignoreAbort = false;
        let configuredUsage;
        try {
          const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
          const replacement = await options.onPayload?.(context, model);
          const payload = replacement === undefined ? context : replacement;
          const payloadText = Array.isArray(payload?.messages) ? lastUserText(payload.messages) : text;
          log({ kind: 'payload', request, payload, lastUser: payloadText });
          const reply = selectReply(script, request, payloadText);
          configuredUsage = reply.usage;
          ignoreAbort = reply.ignoreAbort === true;
          const signal = ignoreAbort ? undefined : options.signal;
          const checkAbort = () => signal?.throwIfAborted();
          const emit = async (event) => {
            await options.onProviderStreamEvent?.(event, model);
            stream.push(event);
          };
          await options.onResponse?.({ status: 200, headers: { 'x-p0-local': 'true' } }, model);
          checkAbort();
          await emit({ type: 'start', partial: message });
          for (const segment of reply.segments ?? []) {
            if (segment.delayMs) await delay(segment.delayMs, undefined, { signal });
            checkAbort();
            if (segment.type === 'error') throw new Error(segment.message ?? 'P0 scripted error');
            if (segment.type === 'hang') {
              log({ kind: 'hang', request, ignoreAbort });
              await new Promise((_resolve, reject) => {
                if (!signal) return;
                const abort = () => reject(signal.reason ?? new Error('aborted'));
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
              });
            } else if (segment.type === 'text' || segment.type === 'thinking') {
              const type = segment.type;
              const contentIndex = message.content.length;
              const block = type === 'text' ? { type, text: '' } : { type, thinking: '' };
              if (segment.signature) block[`${type === 'text' ? 'text' : 'thinking'}Signature`] = segment.signature;
              message.content.push(block);
              await emit({ type: `${type}_start`, contentIndex, partial: message });
              const chunks = segment.chunks ?? [segment.text ?? ''];
              for (const chunk of chunks) {
                const delta = typeof chunk === 'string' ? chunk : chunk.text;
                if (chunk?.delayMs) await delay(chunk.delayMs, undefined, { signal });
                checkAbort();
                block[type === 'text' ? 'text' : 'thinking'] += delta;
                await emit({ type: `${type}_delta`, contentIndex, delta, partial: message });
              }
              await emit({ type: `${type}_end`, contentIndex,
                content: block[type === 'text' ? 'text' : 'thinking'], partial: message });
            } else if (segment.type === 'toolCall') {
              const contentIndex = message.content.length;
              const toolCall = {
                type: 'toolCall', id: segment.id ?? `p0-${request}-${contentIndex}`,
                name: segment.name, arguments: {},
              };
              message.content.push(toolCall);
              await emit({ type: 'toolcall_start', contentIndex, partial: message });
              toolCall.arguments = segment.arguments ?? {};
              await emit({ type: 'toolcall_delta', contentIndex,
                delta: JSON.stringify(toolCall.arguments), partial: message });
              await emit({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
            } else throw new Error(`Unknown P0 segment type: ${segment.type}`);
          }
          checkAbort();
          message.usage = usageOf(reply.usage);
          message.stopReason = reply.stopReason ?? (message.content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop');
          if (reply.error) throw new Error(reply.error);
          await emit({ type: 'done', reason: message.stopReason, message });
          log({ kind: 'done', request, message });
        } catch (error) {
          const aborted = options.signal?.aborted && !ignoreAbort;
          message.stopReason = aborted ? 'aborted' : 'error';
          message.usage = usageOf(configuredUsage);
          message.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
          log({ kind: 'error', request, message });
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
          stream.end();
        }
      })();
      return stream;
    },
  });
}
