import type { AppConfig } from '../config/env.js';
import type { DeviceOverrides } from '../ha/deviceRegistrySource.js';
import { getLogger } from '../logging/logger.js';
import type { SettingsStore } from './SettingsStore.js';
import {
  ENV_SEEDS,
  GROUP_NAMES,
  SECRET_FIELDS,
  VALIDATORS,
  seedFromConfig,
  toStored,
  type GroupName,
  type SettingsGroups,
} from './groups.js';

type Listener<G extends GroupName> = (value: SettingsGroups[G], previous: SettingsGroups[G]) => void;

/**
 * Fonte observável da configuração de runtime (ADR 010, decisões 3 e 5).
 *
 * **Regra única: `.env` e `devices.json` são semente, o banco é a verdade.**
 * Um grupo que nunca foi gravado é semeado no boot a partir deles; daí em
 * diante o banco manda, e um valor divergente no `.env` vira o aviso
 * `config_env_ignored` — nem aplicado em silêncio, nem ignorado em silêncio.
 *
 * Quem consome escolhe quando a mudança vale: `current()` lido na criação da
 * sessão (provider, "na próxima conversa") ou `onChange` para reconfigurar na
 * hora (HA, dispositivos, salas).
 */
export class RuntimeSettings {
  private readonly listeners = new Map<GroupName, Set<Listener<GroupName>>>();
  private merged: AppConfig;

  private constructor(
    private readonly base: AppConfig,
    private readonly store: SettingsStore,
    private values: SettingsGroups,
  ) {
    this.merged = this.merge();
  }

  /**
   * Lê o banco, semeia o que falta e valida tudo. Lança se o que está no banco
   * não passa na validação — mesma falha barulhenta do `loadConfig` com o
   * `.env` errado: o health check do deploy pega.
   */
  static open(
    base: AppConfig,
    store: SettingsStore,
    loadDeviceSeed: () => DeviceOverrides,
    env: NodeJS.ProcessEnv = process.env,
  ): RuntimeSettings {
    const seed = seedFromConfig(base, loadDeviceSeed(), env);
    const values = { ...seed };
    const toSeed: GroupName[] = [];
    const filled: string[] = [];

    // Tudo validado ANTES de qualquer gravação. Uma semente inválida (`.env`
    // sem a chave do provider, `HA_URL` sem esquema) gravada no banco viraria
    // a verdade: o operador corrigiria o `.env`, o banco continuaria vencendo,
    // e o boot falharia para sempre — sem API admin de pé para consertar.
    for (const group of GROUP_NAMES) {
      const stored = store.get(group);
      const set = (value: unknown): void => {
        (values as Record<GroupName, unknown>)[group] = value;
      };
      if (stored === undefined) {
        toSeed.push(group);
        set(validate(group, seed[group], toStored(group, seed[group]), 'no .env/devices.json'));
        continue;
      }
      // Segredo vazio no banco é completado pelo `.env` ANTES de validar —
      // senão a chave do provider escolhido, vazia, falharia a validação e o
      // preenchimento nunca rodaria. Regra assumida: um segredo apagado pelo
      // painel volta no boot se ainda estiver no `.env`; para apagar de vez,
      // tire-o do `.env` também. É a saída para quem subiu sem uma chave e só
      // depois a pôs no `.env`.
      const storedObj = { ...(stored as Record<string, unknown>) };
      const seedValue = seed[group] as unknown as Record<string, unknown>;
      let changed = false;
      for (const secret of SECRET_FIELDS[group] ?? []) {
        if (!storedObj[secret] && seedValue[secret]) {
          storedObj[secret] = seedValue[secret];
          filled.push(`${group}.${secret}`);
          changed = true;
        }
      }
      // Validar por cima da semente preenche campo novo que uma versão
      // anterior não gravava — a migração do conteúdo é aditiva também.
      const value = validate(group, seed[group], storedObj, 'no banco');
      set(value);
      if (changed) store.set(group, toStored(group, values[group]));
    }

    for (const group of toSeed) store.set(group, toStored(group, values[group]));

    if (toSeed.length > 0) {
      getLogger().info(
        { event: 'config_seeded', groups: toSeed },
        `Configuração semeada a partir do .env/devices.json: ${toSeed.join(', ')}`,
      );
    }
    if (filled.length > 0) {
      getLogger().info(
        { event: 'config_env_filled', fields: filled },
        `Segredos vazios no banco completados pelo .env: ${filled.join(', ')}`,
      );
    }

    const settings = new RuntimeSettings(base, store, values);
    settings.warnIgnoredEnv(seed, toSeed, env);
    return settings;
  }

  /** O `AppConfig` do boot com os campos de runtime do banco por cima. */
  current(): AppConfig {
    return this.merged;
  }

  get<G extends GroupName>(group: G): SettingsGroups[G] {
    return this.values[group];
  }

  /**
   * Valida o patch sobre o valor atual, grava e notifica. Lança
   * `SettingsValidationError` sem tocar em nada quando o patch é inválido.
   */
  update<G extends GroupName>(group: G, patch: unknown): SettingsGroups[G] {
    const previous = this.values[group];
    const next = VALIDATORS[group](previous, patch);
    this.store.set(group, toStored(group, next));
    this.values = { ...this.values, [group]: next };
    this.merged = this.merge();

    getLogger().info({ event: 'config_updated', group }, `Configuração "${group}" atualizada`);

    for (const listener of this.listeners.get(group) ?? []) {
      try {
        (listener as Listener<G>)(next, previous);
      } catch (err) {
        // A gravação já aconteceu: um consumidor que falhou ao reconfigurar
        // não pode desfazer a mudança dos outros nem derrubar a requisição.
        getLogger().error(
          { event: 'config_listener_failed', group, err: err instanceof Error ? err.message : String(err) },
          'Falha ao aplicar configuração nova',
        );
      }
    }
    return next;
  }

  onChange<G extends GroupName>(group: G, listener: Listener<G>): void {
    let set = this.listeners.get(group);
    if (!set) {
      set = new Set();
      this.listeners.set(group, set);
    }
    set.add(listener as unknown as Listener<GroupName>);
  }

  updatedAt(group: GroupName): number | null {
    return this.store.updatedAt(group);
  }

  private merge(): AppConfig {
    const { ha, provider } = this.values;
    return Object.freeze({
      ...this.base,
      haUrl: ha.url,
      haToken: ha.token,
      audioProvider: provider.provider,
      geminiApiKey: provider.geminiApiKey,
      openaiApiKey: provider.openaiApiKey,
      geminiLiveModel: provider.geminiLiveModel,
      openaiRealtimeModel: provider.openaiRealtimeModel,
      openaiVoice: provider.openaiVoice,
    });
  }

  /** Nunca loga valor: são segredos, na maioria. Só a variável e o grupo. */
  private warnIgnoredEnv(seed: SettingsGroups, seeded: GroupName[], env: NodeJS.ProcessEnv): void {
    const ignored: string[] = [];
    for (const { group, field, env: name } of ENV_SEEDS) {
      if (seeded.includes(group)) continue;
      const raw = env[name];
      if (raw === undefined || raw.trim() === '') continue;
      const fromEnv = String((seed[group] as unknown as Record<string, unknown>)[field] ?? '');
      const inDb = String((this.values[group] as unknown as Record<string, unknown>)[field] ?? '');
      if (fromEnv !== inDb) ignored.push(name);
    }

    // `devices.json` ausente (ou vazio) não é divergência: é o estado normal
    // de quem já passou a editar os apelidos pelo painel.
    const fileHasContent =
      Object.keys(seed.devices.aliases).length > 0 ||
      seed.devices.exclude.length > 0 ||
      seed.devices.devices.length > 0;
    if (!seeded.includes('devices') && fileHasContent) {
      const same = JSON.stringify(seed.devices) === JSON.stringify(this.values.devices);
      if (!same) ignored.push('devices.json');
    }

    if (ignored.length > 0) {
      getLogger().warn(
        { event: 'config_env_ignored', sources: ignored },
        `Valores do .env/devices.json diferentes do banco foram ignorados (${ignored.join(', ')}): ` +
          'a configuração de runtime vive no banco — edite pelo painel',
      );
    }
  }
}

/** Valida um grupo e diz de onde veio o valor ruim — é a mensagem do boot que falhou. */
function validate<G extends GroupName>(
  group: G,
  current: SettingsGroups[G],
  raw: unknown,
  where: string,
): SettingsGroups[G] {
  try {
    return VALIDATORS[group](current, raw);
  } catch (err) {
    throw new Error(
      `Configuração "${group}" inválida ${where}: ` + (err instanceof Error ? err.message : String(err)),
    );
  }
}
