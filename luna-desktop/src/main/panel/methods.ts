// Tudo que a janela do painel pode pedir ao processo principal. É uma
// whitelist: o preload expõe um único `call(method, ...args)`, e só o que está
// nesta tabela responde — um nome desconhecido, ou argumento do tipo errado,
// vira erro sem tocar em nada (ADR 010, decisão 6: o painel exibe dado vindo
// de fora e não deve ter acesso genérico a nada).
//
// Módulo puro (sem `electron`), testável com `node --test`.

import type { AdminClient, AdminResult } from '../admin/client.js';
import { validFilter, type LogFilter } from '../admin/logStream.js';
import type { LocalSettingsPatch } from '../local-settings.js';
import type { AppState } from '../state.js';

/** O que a tela "Este computador" mostra. Segredo nunca sai: só a origem. */
export interface LocalView {
  serverUrl: string;
  roomId: string;
  deviceId: string;
  micDeviceId: string;
  speakerDeviceId: string;
  authSecret: { set: boolean; source: 'panel' | 'env' | 'none' };
  adminToken: { set: boolean; source: 'panel' | 'env' | 'none' };
  muted: boolean;
  autostart: boolean;
  state: AppState;
  /** Por que o satélite não está de pé, quando não está. */
  configError: string | null;
  version: string;
}

export interface AudioDeviceInfo {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput';
  label: string;
}

export interface LocalControls {
  view(): LocalView;
  /** Grava e aplica. Lança LocalSettingsError em validação. */
  save(patch: LocalSettingsPatch): Promise<LocalView>;
  setMuted(muted: boolean): void;
  forceListen(): void;
  setAutostart(enabled: boolean): void;
  openDataDir(): void;
  listAudioDevices(): Promise<AudioDeviceInfo[]>;
}

/** Log ao vivo do servidor; as linhas chegam ao painel como evento, não como resposta. */
export interface LogControls {
  start(filter: LogFilter): void;
  stop(): void;
}

export interface PanelDeps {
  admin: AdminClient;
  local: LocalControls;
  logs: LogControls;
}

export type PanelResult = AdminResult;

type Method = (...args: unknown[]) => Promise<PanelResult>;

const SERVER_GROUPS = new Set(['ha', 'provider', 'calendar']);

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError(`argumento "${name}" inválido`);
  }
  return value;
}

function group(value: unknown): string {
  const g = str(value, 'grupo');
  if (!SERVER_GROUPS.has(g)) throw new TypeError(`grupo "${g}" desconhecido`);
  return g;
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`argumento "${name}" deve ser um objeto`);
  }
  return value as Record<string, unknown>;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`argumento "${name}" deve ser booleano`);
  return value;
}

function int(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`argumento "${name}" inválido`);
  }
  return value as number;
}

const seg = encodeURIComponent;

function ok(body: unknown): PanelResult {
  return { ok: true, status: 200, body };
}

export function createPanelMethods(deps: PanelDeps): Record<string, Method> {
  const { admin, local, logs } = deps;
  const methods: Record<string, (...args: unknown[]) => Promise<PanelResult> | PanelResult> = {
    // ─── servidor (API admin) ───
    'server.status': () => admin.request('GET', 'status'),
    'server.bootstrap': () => admin.request('GET', 'bootstrap'),
    'server.satellites': () => admin.request('GET', 'satellites'),
    'server.renameSatellite': (deviceId, name) =>
      admin.request('PUT', `satellites/${seg(str(deviceId, 'device_id'))}`, {
        name: name === null ? null : String(name ?? ''),
      }),
    'server.rooms': () => admin.request('GET', 'rooms'),
    'server.mapRoom': (roomId, area) =>
      admin.request('PUT', `rooms/${seg(str(roomId, 'room_id'))}`, {
        area: area === null || area === '' ? null : str(area, 'area'),
      }),
    'server.devices': () => admin.request('GET', 'devices'),
    'server.saveAliases': (aliases) => admin.request('PUT', 'devices', { aliases: obj(aliases, 'aliases') }),
    'server.reminders': () => admin.request('GET', 'reminders'),
    'server.cancelReminder': (id) => admin.request('DELETE', `reminders/${int(id, 'id', 1, Number.MAX_SAFE_INTEGER)}`),
    'server.createReminder': (body) => admin.request('POST', 'reminders', obj(body, 'lembrete')),
    'server.editReminder': (id, body) =>
      admin.request('PUT', `reminders/${int(id, 'id', 1, Number.MAX_SAFE_INTEGER)}`, obj(body, 'lembrete')),
    'server.reminderHistory': (limit) => admin.request('GET', `reminders/history?limit=${int(limit ?? 50, 'limit', 1, 500)}`),
    'server.settings': (g) => admin.request('GET', `settings/${group(g)}`),
    'server.saveSettings': (g, patch) => admin.request('PUT', `settings/${group(g)}`, obj(patch, 'patch')),
    'server.testConnection': (g, patch) =>
      admin.request('POST', `settings/${group(g)}/test`, obj(patch ?? {}, 'patch')),
    'server.restart': () => admin.request('POST', 'restart'),
    'server.latency': (hours) => admin.request('GET', `diagnostics/latency?hours=${int(hours ?? 24, 'hours', 1, 720)}`),
    'server.errors': (limit) => admin.request('GET', `diagnostics/errors?limit=${int(limit ?? 20, 'limit', 1, 200)}`),

    // ─── log ao vivo ───
    'logs.start': (level, room) => {
      logs.start(validFilter(level, room ?? null));
      return ok(null);
    },
    'logs.stop': () => {
      logs.stop();
      return ok(null);
    },

    // ─── este computador ───
    'local.get': () => ok(local.view()),
    'local.save': async (patch) => ok(await local.save(obj(patch, 'patch') as LocalSettingsPatch)),
    'local.setMuted': (muted) => {
      local.setMuted(bool(muted, 'muted'));
      return ok(local.view());
    },
    'local.forceListen': () => {
      local.forceListen();
      return ok(local.view());
    },
    'local.setAutostart': (enabled) => {
      local.setAutostart(bool(enabled, 'enabled'));
      return ok(local.view());
    },
    'local.openDataDir': () => {
      local.openDataDir();
      return ok(null);
    },
    'local.audioDevices': async () => ok(await local.listAudioDevices()),
  };

  // Todo método vira async e nunca rejeita: o painel recebe sempre um
  // PanelResult, com a mensagem de erro pronta para mostrar.
  const wrapped: Record<string, Method> = {};
  for (const [name, fn] of Object.entries(methods)) {
    wrapped[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        const field = (err as { field?: unknown }).field;
        return {
          ok: false,
          status: err instanceof TypeError ? 400 : 422,
          body: {
            error: err instanceof Error ? err.message : String(err),
            ...(typeof field === 'string' ? { field } : {}),
          },
        };
      }
    };
  }
  return wrapped;
}
