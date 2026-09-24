// Interface do painel de controle (docs/painel-de-controle.md, v1).
//
// Script clássico, sem import/export — mesmo motivo de renderer.ts: carregado
// de file:// como <script src>, sem a checagem de MIME de `type="module"`. O
// `export {}` que o tsc emite por causa do `declare global` é removido por
// scripts/copy-renderer.mjs.
//
// Regra de segurança deste arquivo: dado vindo de fora (nomes do HA, rótulos
// de lembrete, respostas do servidor) só entra no DOM por `textContent`, via
// `h()`. Nada de innerHTML.

declare global {
  interface PanelResult {
    ok: boolean;
    status: number;
    body: any;
  }

  interface PanelBridge {
    call(method: string, ...args: unknown[]): Promise<PanelResult>;
    onEvent(callback: (event: any) => void): void;
  }

  interface Window {
    panel: PanelBridge;
  }
}

type Child = Node | string | number | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'style') {
      // CSSOM, não atributo: a CSP (`style-src 'self'`) bloqueia `style="..."`
      // posto por setAttribute, mas não `el.style`.
      el.style.cssText = String(value);
    } else if (key in el && typeof value !== 'string') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return el;
}

// ─── infraestrutura ──────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(message: string, isError = false): void {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), isError ? 6000 : 2800);
}

function errorOf(result: PanelResult): string {
  return (result.body && typeof result.body.error === 'string' && result.body.error) || `HTTP ${result.status}`;
}

/** Chamada que mostra o erro sozinha; devolve `null` quando falhou. */
async function call(method: string, ...args: unknown[]): Promise<any | null> {
  const result = await window.panel.call(method, ...args);
  if (!result.ok) {
    toast(errorOf(result), true);
    return null;
  }
  return result.body;
}

function formatAgo(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const hh = Math.floor((seconds % 86400) / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${hh}h`;
  if (hh > 0) return `${hh}h ${mm}min`;
  return `${mm} min`;
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "definido (…a1b2)" / "definido" / "não definido" — nunca o valor. */
function describeSecret(secret: { set: boolean; last4?: string | null } | undefined): string {
  if (!secret?.set) return 'não definido';
  return secret.last4 ? `definido (…${secret.last4})` : 'definido';
}

function card(title: string | null, ...children: Child[]): HTMLElement {
  return h('div', { class: 'card' }, title ? h('h2', {}, title) : null, ...children);
}

function field(label: string, input: HTMLElement, hint?: string): Node[] {
  const nodes: Node[] = [h('label', {}, label), input];
  if (hint) nodes.push(h('div', { class: 'hint' }, hint));
  return nodes;
}

/** Marca o input do campo que o servidor recusou (422 com `field`). */
function markInvalid(form: HTMLElement, result: PanelResult): void {
  form.querySelectorAll('input.invalid').forEach((el) => el.classList.remove('invalid'));
  const name = result.body?.field;
  if (typeof name === 'string') form.querySelector(`[name="${CSS.escape(name)}"]`)?.classList.add('invalid');
}

// ─── navegação ───────────────────────────────────────────────────────────

interface Page {
  id: string;
  title: string;
  group: string;
  render(root: HTMLElement): Promise<void>;
  /** Recarrega sozinho enquanto a página está aberta. */
  pollMs?: number;
}

const pages: Page[] = [];
let currentPage: Page | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Descarta respostas de uma página que o usuário já trocou. */
let renderSeq = 0;

async function show(id: string): Promise<void> {
  const page = pages.find((p) => p.id === id) ?? pages[0]!;
  currentPage = page;
  if (location.hash !== `#${page.id}`) history.replaceState(null, '', `#${page.id}`);
  document.getElementById('page-title')!.textContent = page.title;
  document.querySelectorAll('nav button').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.page === page.id);
  });
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  await renderCurrent();
  if (page.pollMs) pollTimer = setInterval(() => void renderCurrent(true), page.pollMs);
}

async function renderCurrent(quiet = false): Promise<void> {
  const page = currentPage;
  if (!page) return;
  const seq = ++renderSeq;
  const root = h('div');
  try {
    await page.render(root);
  } catch (err) {
    root.append(h('div', { class: 'notice error' }, `Falha ao carregar: ${String(err)}`));
  }
  if (seq !== renderSeq) return;
  // Não repinta por cima de um formulário sendo editado.
  const slot = document.getElementById('page')!;
  if (quiet && slot.contains(document.activeElement) && document.activeElement !== document.body) return;
  slot.replaceChildren(root);
}

/** O servidor não está acessível: explica por quê e aponta para onde se resolve. */
function serverUnavailable(root: HTMLElement, result: PanelResult): void {
  root.append(
    h(
      'div',
      { class: 'notice error' },
      errorOf(result),
      ' ',
      h('button', { class: 'ghost', type: 'button', onclick: () => void show('local') }, 'Abrir Este computador'),
    ),
  );
}

// ─── Início ──────────────────────────────────────────────────────────────

const LIGHT_LABELS: Record<string, string> = {
  ha: 'Home Assistant',
  provider: 'Provedor de IA',
  weather: 'Clima',
  calendar: 'Agenda',
};

pages.push({
  id: 'home',
  title: 'Início',
  group: 'Luna',
  pollMs: 5000,
  async render(root) {
    const result = await window.panel.call('server.status');
    if (!result.ok) return serverUnavailable(root, result);
    const status = result.body;

    root.append(
      h(
        'div',
        { class: 'grid' },
        card('Servidor', h('div', { class: 'stat' }, 'Online'), h('div', { class: 'muted' }, `v${status.version} · ligado há ${formatUptime(status.uptime_s)}`)),
        card(
          'Satélites conectados',
          h('div', { class: 'stat' }, status.satellites_online),
          h('div', { class: 'muted' }, h('a', { href: '#satellites' }, 'ver satélites')),
        ),
      ),
    );

    const lights = h('ul', { class: 'lights' });
    for (const [key, label] of Object.entries(LIGHT_LABELS)) {
      const conn = status.connections?.[key] ?? { light: 'unknown', detail: '' };
      lights.append(
        h('li', {}, h('span', { class: `light ${conn.light}` }), h('strong', {}, label), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, conn.detail)),
      );
    }
    root.append(h('div', { style: 'height:14px' }), card('Conexões', lights));

    const next = status.next_reminders as any[];
    root.append(
      card(
        'Próximos lembretes e alarmes',
        next.length === 0
          ? h('div', { class: 'empty' }, 'Nada marcado.')
          : h(
              'ul',
              { class: 'lights' },
              ...next.map((r) =>
                h('li', {}, h('span', { class: 'mono' }, r.short_id), h('span', {}, r.label ?? 'Alarme'), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${r.room_id} · ${formatDateTime(r.next_due_utc)}`)),
              ),
            ),
      ),
    );
  },
});

// ─── Satélites ───────────────────────────────────────────────────────────

pages.push({
  id: 'satellites',
  title: 'Satélites',
  group: 'Luna',
  pollMs: 10000,
  async render(root) {
    const result = await window.panel.call('server.satellites');
    if (!result.ok) return serverUnavailable(root, result);
    const sats = result.body.satellites as any[];
    if (sats.length === 0) {
      root.append(card(null, h('div', { class: 'empty' }, 'Nenhum satélite conectou desde que o servidor ligou.')));
      return;
    }

    const rows = sats.map((s) => {
      const name = h('input', { value: s.name ?? '', placeholder: 'Sem nome', maxLength: 64 }) as HTMLInputElement;
      const save = h(
        'button',
        {
          class: 'ghost',
          type: 'button',
          onclick: async () => {
            const body = await call('server.renameSatellite', s.device_id, name.value.trim() || null);
            if (body) toast('Nome salvo.');
          },
        },
        'Salvar',
      );
      return h(
        'tr',
        {},
        h('td', {}, h('span', { class: `light ${s.online ? 'ok' : ''}`, title: s.online ? 'online' : 'offline' })),
        h('td', {}, h('div', { class: 'inline' }, name, save)),
        h('td', { class: 'mono' }, s.device_id),
        h('td', {}, s.room_id ?? '—'),
        h('td', { class: 'muted' }, s.online ? `desde ${formatAgo(s.connected_since)}` : 'offline'),
        h('td', { class: 'muted' }, formatAgo(s.last_seen_at)),
      );
    });

    root.append(
      card(
        null,
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Nome'), h('th', {}, 'device_id'), h('th', {}, 'Sala'), h('th', {}, 'Conexão'), h('th', {}, 'Último sinal'))),
          h('tbody', {}, ...rows),
        ),
      ),
      h('p', { class: 'muted small' }, 'Satélites offline só aparecem se conectaram desde o último boot do servidor ou se têm nome.'),
    );
  },
});

// ─── Salas e dispositivos ────────────────────────────────────────────────

pages.push({
  id: 'rooms',
  title: 'Salas e dispositivos',
  group: 'Luna',
  async render(root) {
    const [roomsRes, devicesRes] = await Promise.all([
      window.panel.call('server.rooms'),
      window.panel.call('server.devices'),
    ]);
    if (!roomsRes.ok) return serverUnavailable(root, roomsRes);
    const { rooms, ha_areas: haAreas } = roomsRes.body as { rooms: any[]; ha_areas: string[] };

    root.append(
      h(
        'div',
        { class: 'notice info' },
        'Uma sala sem área própria no Home Assistant (como a do luna-desktop) pode apontar para uma área — os comandos de lá passam a acionar os dispositivos dela. Vale na hora.',
      ),
    );

    const grid = h('div', { class: 'grid' });
    for (const room of rooms) {
      const select = h('select') as HTMLSelectElement;
      select.append(h('option', { value: '' }, room.is_ha_area ? '— a própria área —' : '— nenhuma —'));
      for (const area of haAreas) {
        if (area === room.room_id) continue;
        select.append(h('option', { value: area, selected: room.area === area }, area));
      }
      select.addEventListener('change', async () => {
        const body = await call('server.mapRoom', room.room_id, select.value || null);
        if (body) {
          toast(body.area ? `${room.room_id} → ${body.area}` : `${room.room_id} sem mapeamento`);
          void renderCurrent();
        }
      });

      grid.append(
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'card-head' },
            h('h2', {}, room.room_id),
            h('div', { class: 'row' }, room.has_satellite ? h('span', { class: 'badge ok' }, 'satélite') : null, room.is_ha_area ? h('span', { class: 'badge accent' }, 'área do HA') : null),
          ),
          h('div', { class: 'form' }, ...field('Usa a área', select)),
          room.devices.length === 0
            ? h('div', { class: 'muted small', style: 'margin-top:10px' }, 'A Luna não enxerga nenhum dispositivo aqui.')
            : h('div', { class: 'devices' }, ...room.devices.map((d: any) => h('span', { class: 'chip', title: d.entity_id }, d.name ?? d.device))),
        ),
      );
    }
    root.append(grid.childElementCount ? grid : card(null, h('div', { class: 'empty' }, 'Nenhuma sala conhecida ainda.')));

    if (devicesRes.ok) root.append(h('div', { style: 'height:14px' }), aliasEditor(devicesRes.body.aliases ?? {}));
  },
});

/** Apelido falado → dispositivo. Salvo inteiro, de uma vez. */
function aliasEditor(initial: Record<string, string>): HTMLElement {
  const tbody = h('tbody');
  const addRow = (alias = '', target = ''): void => {
    const row = h(
      'tr',
      {},
      h('td', {}, h('input', { value: alias, placeholder: 'luz da bancada', 'data-role': 'alias' })),
      h('td', {}, h('input', { value: target, placeholder: 'luz_bancada', 'data-role': 'target' })),
      h('td', {}, h('button', { class: 'danger', type: 'button', onclick: () => row.remove() }, 'Remover')),
    );
    tbody.append(row);
  };
  for (const [alias, target] of Object.entries(initial)) addRow(alias, target);

  const save = async (): Promise<void> => {
    const aliases: Record<string, string> = {};
    for (const row of Array.from(tbody.children)) {
      const alias = (row.querySelector('[data-role=alias]') as HTMLInputElement).value.trim();
      const target = (row.querySelector('[data-role=target]') as HTMLInputElement).value.trim();
      if (alias && target) aliases[alias] = target;
    }
    const body = await call('server.saveAliases', aliases);
    if (body) toast('Apelidos salvos — valem na hora.');
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Apelidos'), h('span', { class: 'muted small' }, 'Como a Luna ouve → o dispositivo real')),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Apelido falado'), h('th', {}, 'Dispositivo'), h('th', {}))), tbody),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'ghost', type: 'button', onclick: () => addRow() }, 'Adicionar'),
      h('button', { type: 'button', onclick: () => void save() }, 'Salvar apelidos'),
    ),
  );
}

// ─── Integrações ─────────────────────────────────────────────────────────

interface FieldSpec {
  name: string;
  label: string;
  secret?: boolean;
  options?: Array<[string, string]>;
  hint?: string;
  placeholder?: string;
}

/**
 * Formulário de um grupo do servidor. Segredo em branco = mantém o atual
 * (a API é só de substituição); só vai no patch o que o usuário digitou.
 */
function settingsForm(
  group: string,
  title: string,
  value: Record<string, any>,
  specs: FieldSpec[],
  opts: { testable?: boolean; note?: string },
): HTMLElement {
  const form = h('div', { class: 'form' });
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

  for (const spec of specs) {
    let input: HTMLInputElement | HTMLSelectElement;
    if (spec.options) {
      input = h('select', { name: spec.name }) as HTMLSelectElement;
      for (const [v, label] of spec.options) input.append(h('option', { value: v, selected: value[spec.name] === v }, label));
    } else if (spec.secret) {
      input = h('input', {
        name: spec.name,
        type: 'password',
        autocomplete: 'off',
        placeholder: value[spec.name]?.set ? `${describeSecret(value[spec.name])} — deixe em branco para manter` : 'não definido',
      }) as HTMLInputElement;
    } else {
      input = h('input', { name: spec.name, value: value[spec.name] ?? '', placeholder: spec.placeholder ?? '' }) as HTMLInputElement;
    }
    inputs.set(spec.name, input);
    form.append(...field(spec.label, input, spec.hint));
  }

  const patch = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const spec of specs) {
      const v = inputs.get(spec.name)!.value;
      if (spec.secret && v.trim() === '') continue;
      out[spec.name] = v;
    }
    return out;
  };

  const status = h('span', { class: 'muted small' });
  const actions = h('div', { class: 'actions' }, status, h('span', { class: 'spacer' }));

  if (opts.testable) {
    actions.append(
      h(
        'button',
        {
          class: 'ghost',
          type: 'button',
          onclick: async () => {
            status.textContent = 'Testando…';
            const result = await window.panel.call('server.testConnection', group, patch());
            const body = result.body ?? {};
            status.textContent = result.ok && body.ok
              ? `Conectou (${body.latency_ms} ms)`
              : `Falhou: ${body.error ?? errorOf(result)}`;
          },
        },
        'Testar conexão',
      ),
    );
  }

  actions.append(
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          const result = await window.panel.call('server.saveSettings', group, patch());
          markInvalid(form, result);
          if (!result.ok) return toast(errorOf(result), true);
          toast(result.body.applies === 'next_session' ? `${title}: salvo — vale na próxima conversa.` : `${title}: salvo — já está valendo.`);
          void renderCurrent();
        },
      },
      'Salvar',
    ),
  );

  return h(
    'div',
    { class: 'card' },
    h('h2', {}, title),
    opts.note ? h('div', { class: 'notice info' }, opts.note) : null,
    form,
    actions,
  );
}

pages.push({
  id: 'integrations',
  title: 'Integrações',
  group: 'Luna',
  async render(root) {
    const [ha, provider, calendar] = await Promise.all(
      ['ha', 'provider', 'calendar'].map((g) => window.panel.call('server.settings', g)),
    );
    if (!ha!.ok) return serverUnavailable(root, ha!);

    root.append(
      settingsForm('ha', 'Home Assistant', ha!.body.value, [
        { name: 'url', label: 'URL', placeholder: 'http://192.168.0.10:8123' },
        { name: 'token', label: 'Token', secret: true, hint: 'Long-Lived Access Token do perfil do HA.' },
      ], { testable: true, note: 'Trocar URL ou token vale na hora e redescobre os dispositivos.' }),
    );

    if (provider!.ok) {
      root.append(
        settingsForm('provider', 'Provedor de IA', provider!.body.value, [
          { name: 'provider', label: 'Provedor', options: [['gemini', 'Gemini Live'], ['openai', 'OpenAI Realtime']] },
          { name: 'geminiLiveModel', label: 'Modelo Gemini' },
          { name: 'geminiApiKey', label: 'Chave Gemini', secret: true },
          { name: 'openaiRealtimeModel', label: 'Modelo OpenAI' },
          { name: 'openaiVoice', label: 'Voz OpenAI', hint: 'Ex.: marin, cedar, alloy.' },
          { name: 'openaiApiKey', label: 'Chave OpenAI', secret: true },
        ], { note: 'Vale na próxima conversa de cada sala — a que está em curso não é interrompida.' }),
      );
    }

    if (calendar!.ok) {
      root.append(
        settingsForm('calendar', 'Agenda', calendar!.body.value, [
          { name: 'url', label: 'URL da API', placeholder: 'https://agenda.local/api' },
          { name: 'token', label: 'Credencial', secret: true },
        ], {
          testable: true,
          note: 'Só a conexão, por enquanto: a Luna ainda não consulta a agenda (depende da API do app). O teste só confirma que a URL responde.',
        }),
      );
    }
  },
});

// ─── Lembretes ───────────────────────────────────────────────────────────

const REPEAT_LABELS: Record<string, string> = {
  daily: 'todo dia',
  weekdays: 'dias úteis',
  weekend: 'fim de semana',
  mon: 'segundas',
  tue: 'terças',
  wed: 'quartas',
  thu: 'quintas',
  fri: 'sextas',
  sat: 'sábados',
  sun: 'domingos',
};

pages.push({
  id: 'reminders',
  title: 'Lembretes e alarmes',
  group: 'Luna',
  pollMs: 15000,
  async render(root) {
    const result = await window.panel.call('server.reminders');
    if (!result.ok) return serverUnavailable(root, result);
    const reminders = result.body.reminders as any[];
    if (reminders.length === 0) {
      root.append(card(null, h('div', { class: 'empty' }, 'Nada marcado. Peça à Luna: "me lembra de…"')));
      return;
    }
    const rows = reminders.map((r) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono' }, r.short_id),
        h('td', {}, r.label ?? h('span', { class: 'muted' }, 'Alarme'), r.status === 'ringing' ? h('span', { class: 'badge accent', style: 'margin-left:6px' }, 'tocando') : null),
        h('td', {}, r.room_id),
        h('td', {}, formatDateTime(r.next_due_utc)),
        h('td', { class: 'muted' }, r.repeat_rule ? REPEAT_LABELS[r.repeat_rule] ?? r.repeat_rule : 'uma vez'),
        h(
          'td',
          {},
          h(
            'button',
            {
              class: 'danger',
              type: 'button',
              onclick: async () => {
                if (!confirm(`Cancelar "${r.label ?? 'alarme'}" (${r.short_id})?`)) return;
                if (await call('server.cancelReminder', r.id)) {
                  toast('Cancelado.');
                  void renderCurrent();
                }
              },
            },
            'Cancelar',
          ),
        ),
      ),
    );
    root.append(
      card(
        null,
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Código'), h('th', {}, 'Rótulo'), h('th', {}, 'Sala'), h('th', {}, 'Próximo'), h('th', {}, 'Repete'), h('th', {}))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  },
});

// ─── Este computador ─────────────────────────────────────────────────────

let micFill: HTMLElement | null = null;
let wakeFill: HTMLElement | null = null;
let wakeMark: HTMLElement | null = null;
let wakeBox: HTMLElement | null = null;

const SOURCE_LABELS: Record<string, string> = { panel: 'gravado aqui', env: 'vindo do .env', none: 'não definido' };

pages.push({
  id: 'local',
  title: 'Este computador',
  group: 'Este computador',
  async render(root) {
    const [viewRes, devicesRes] = await Promise.all([
      window.panel.call('local.get'),
      window.panel.call('local.audioDevices'),
    ]);
    const view = viewRes.body;
    const devices = (devicesRes.ok ? devicesRes.body : []) as Array<{ deviceId: string; kind: string; label: string }>;

    if (view.configError) root.append(h('div', { class: 'notice error' }, view.configError));

    // Conexão
    const form = h('div', { class: 'form' });
    const serverUrl = h('input', { name: 'serverUrl', value: view.serverUrl, placeholder: 'ws://192.168.0.20:8080' }) as HTMLInputElement;
    const roomId = h('input', { name: 'roomId', value: view.roomId }) as HTMLInputElement;
    const secretHint = (s: { set: boolean; source: string }): string =>
      s.set ? `definido (${SOURCE_LABELS[s.source]}) — em branco mantém` : 'não definido';
    const secret = h('input', { name: 'authSecret', type: 'password', autocomplete: 'off', placeholder: secretHint(view.authSecret) }) as HTMLInputElement;
    const token = h('input', { name: 'adminToken', type: 'password', autocomplete: 'off', placeholder: secretHint(view.adminToken) }) as HTMLInputElement;
    form.append(
      ...field('Servidor', serverUrl, 'A mesma porta serve o satélite (WebSocket) e o painel.'),
      ...field('Sala (room_id)', roomId, 'Minúsculas, dígitos e _. Mapeie para uma área do HA em Salas e dispositivos.'),
      ...field('Segredo do satélite', secret, 'O WS_AUTH_SECRET do servidor.'),
      ...field('Token admin', token, 'O LUNA_ADMIN_TOKEN do servidor — libera as telas do servidor neste painel.'),
    );
    const saveConn = async (): Promise<void> => {
      const patch: Record<string, string> = { serverUrl: serverUrl.value, roomId: roomId.value };
      if (secret.value.trim()) patch.authSecret = secret.value;
      if (token.value.trim()) patch.adminToken = token.value;
      const result = await window.panel.call('local.save', patch);
      markInvalid(form, result);
      if (!result.ok) return toast(errorOf(result), true);
      toast('Salvo. Reconectando se algo da conexão mudou.');
      void renderCurrent();
    };
    root.append(
      card(
        'Conexão com o servidor',
        form,
        h('div', { class: 'actions' }, h('span', { class: 'muted small mono' }, `device_id ${view.deviceId}`), h('span', { class: 'spacer' }), h('button', { type: 'button', onclick: () => void saveConn() }, 'Salvar e reconectar')),
      ),
    );

    // Áudio
    const deviceSelect = (kind: string, current: string, name: string): HTMLSelectElement => {
      const select = h('select', { name }) as HTMLSelectElement;
      select.append(h('option', { value: '' }, 'Padrão do sistema'));
      for (const d of devices.filter((x) => x.kind === kind)) {
        select.append(h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || 'Dispositivo sem nome'));
      }
      select.addEventListener('change', async () => {
        if (await call('local.save', { [name]: select.value })) toast('Dispositivo trocado.');
      });
      return select;
    };

    micFill = h('div', { class: 'meter-fill' });
    wakeFill = h('div', { class: 'meter-fill wake' });
    wakeMark = h('div', { class: 'meter-mark', style: 'display:none' });
    wakeBox = h('div', { class: 'meter' }, wakeFill, wakeMark);

    root.append(
      card(
        'Áudio',
        h(
          'div',
          { class: 'form' },
          ...field('Microfone', deviceSelect('audioinput', view.micDeviceId, 'micDeviceId')),
          ...field('Alto-falante', deviceSelect('audiooutput', view.speakerDeviceId, 'speakerDeviceId')),
          ...field('Nível do mic', h('div', { class: 'meter' }, micFill)),
          ...field('Score "Hey Luna"', wakeBox, 'A marca amarela é o threshold: o pico passa dela quando a Luna acorda.'),
        ),
        devicesRes.ok ? null : h('div', { class: 'muted small' }, 'Não consegui listar os dispositivos — a captura ainda não está pronta.'),
      ),
    );

    // Controles
    const muted = h('input', {
      type: 'checkbox',
      checked: view.muted,
      onchange: async (e: Event) => {
        await call('local.setMuted', (e.target as HTMLInputElement).checked);
      },
    });
    const autostart = h('input', {
      type: 'checkbox',
      checked: view.autostart,
      onchange: async (e: Event) => {
        await call('local.setAutostart', (e.target as HTMLInputElement).checked);
      },
    });
    root.append(
      card(
        'Controles',
        h(
          'div',
          { class: 'form' },
          ...field('Mutar microfone', muted),
          ...field('Iniciar com o Windows', autostart),
        ),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'ghost', type: 'button', onclick: () => void call('local.openDataDir') }, 'Abrir pasta de dados'),
          h('button', { type: 'button', disabled: view.muted, onclick: async () => { if (await call('local.forceListen')) toast('Ouvindo — pode falar.'); } }, 'Forçar escuta agora'),
        ),
      ),
    );
  },
});

// ─── Servidor ────────────────────────────────────────────────────────────

pages.push({
  id: 'server',
  title: 'Servidor',
  group: 'Servidor',
  async render(root) {
    const result = await window.panel.call('server.bootstrap');
    if (!result.ok) return serverUnavailable(root, result);
    const b = result.body;
    root.append(
      card(
        'Configuração de boot',
        h('div', { class: 'notice info' }, 'Só leitura: estes valores vêm do .env do servidor e só mudam com restart.'),
        h(
          'div',
          { class: 'form' },
          ...field('Versão', h('span', { class: 'mono' }, b.version)),
          ...field('Porta', h('span', { class: 'mono' }, b.ws_port)),
          ...field('Banco', h('span', { class: 'mono' }, b.db_path)),
          ...field('Nível de log', h('span', { class: 'mono' }, b.log_level)),
          ...field('Segredo dos satélites', h('span', {}, describeSecret(b.ws_auth_secret))),
          ...field('Token admin', h('span', {}, describeSecret(b.admin_token))),
        ),
      ),
      card(
        'Reiniciar o servidor',
        h('p', { class: 'muted' }, 'Saída de emergência. Derruba as conversas em curso e qualquer alarme tocando; o systemd traz o servidor de volta em alguns segundos.'),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'danger',
              type: 'button',
              onclick: async () => {
                if (!confirm('Reiniciar o servidor da Luna agora?')) return;
                if (await call('server.restart')) toast('Reiniciando…');
              },
            },
            'Reiniciar servidor',
          ),
        ),
      ),
    );
  },
});

// ─── eventos ao vivo ─────────────────────────────────────────────────────

window.panel.onEvent((event) => {
  switch (event?.type) {
    case 'navigate':
      void show(String(event.tab));
      break;
    case 'local': {
      const dot = document.getElementById('brand-dot')!;
      dot.className = `brand-dot ${event.view.state}`;
      document.getElementById('brand-sub')!.textContent = event.view.muted ? 'microfone mudo' : `sala ${event.view.roomId}`;
      break;
    }
    case 'mic':
      if (micFill?.isConnected) micFill.style.width = `${Math.min(100, Math.sqrt(event.level) * 160)}%`;
      break;
    case 'wake-score':
      if (wakeFill?.isConnected) {
        wakeFill.style.width = `${Math.min(100, event.score * 100)}%`;
        if (wakeMark && typeof event.threshold === 'number') {
          wakeMark.style.display = '';
          wakeMark.style.left = `${event.threshold * 100}%`;
        }
      }
      break;
    case 'wake':
      if (wakeBox?.isConnected) {
        wakeBox.classList.remove('flash');
        void wakeBox.offsetWidth;
        wakeBox.classList.add('flash');
      }
      break;
  }
});

// ─── boot ────────────────────────────────────────────────────────────────

function buildNav(): void {
  const nav = document.getElementById('nav')!;
  let group = '';
  for (const page of pages) {
    if (page.group !== group) {
      group = page.group;
      nav.append(h('div', { class: 'nav-group' }, group));
    }
    nav.append(h('button', { type: 'button', 'data-page': page.id, onclick: () => void show(page.id) }, page.title));
  }
}

buildNav();
document.getElementById('refresh')!.addEventListener('click', () => void renderCurrent());
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== currentPage?.id) void show(id);
});
void window.panel.call('local.get').then((result) => {
  if (result.ok) {
    document.getElementById('brand-dot')!.className = `brand-dot ${result.body.state}`;
    document.getElementById('brand-sub')!.textContent = `sala ${result.body.roomId}`;
  }
});
void show(location.hash.slice(1) || 'home');
