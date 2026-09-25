// Interface do painel de controle (docs/painel-de-controle.md, v1), no sistema
// visual "LUNA 6000" (docs/design-system-painel.md).
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

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ─── movimento ───────────────────────────────────────────────────────────
//
// Texto novo é "digitado" com cursor █. Com prefers-reduced-motion, aparece
// inteiro e o cursor não pisca (o CSS desliga as animações).

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = (): boolean => motionQuery.matches;

function cursor(tone?: 'amber' | 'red'): HTMLElement {
  return h('span', { class: `cursor${tone ? ` ${tone}` : ''}`, 'aria-hidden': 'true' }, '█');
}

const typingTimers = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

/** Digita `text` em `el` a `cps` caracteres por segundo, trocando qualquer digitação anterior. */
function typeInto(
  el: HTMLElement,
  text: string,
  opts: { cps?: number; delayMs?: number; cursor?: 'amber' | 'red' | 'hi'; keepCursor?: boolean } = {},
): void {
  const previous = typingTimers.get(el);
  if (previous) clearInterval(previous);
  const withCursor = (): void => {
    if (opts.cursor) el.append(cursor(opts.cursor === 'hi' ? undefined : opts.cursor));
  };
  if (reduced()) {
    el.textContent = text;
    if (opts.keepCursor) withCursor();
    return;
  }
  const cps = opts.cps ?? 55;
  const start = performance.now() + (opts.delayMs ?? 0);
  el.textContent = '';
  // O elemento costuma nascer fora do DOM (a página monta tudo e só então
  // entra); só desiste se ele sair depois de ter entrado, ou nunca entrar.
  let seen = false;
  const step = (): void => {
    if (el.isConnected) seen = true;
    else if (seen || performance.now() - start > 10_000) {
      clearInterval(timer);
      return;
    }
    const n = Math.max(0, Math.floor(((performance.now() - start) / 1000) * cps));
    const done = n >= text.length;
    el.textContent = done ? text : text.slice(0, n);
    if (!done || opts.keepCursor) withCursor();
    if (done) clearInterval(timer);
  };
  const timer = setInterval(step, 30);
  typingTimers.set(el, timer);
  step();
}

/** Elemento que se digita sozinho assim que entra na página. */
function typed(tag: 'span' | 'div', attrs: Record<string, unknown>, text: string, opts: Parameters<typeof typeInto>[2] = {}): HTMLElement {
  const el = h(tag, attrs);
  queueMicrotask(() => typeInto(el, text, opts));
  return el;
}

// ─── linha de comando (substitui toasts) ─────────────────────────────────

function say(text: string, tone: 'ok' | 'warn' = 'ok'): void {
  const el = $('cmd');
  el.className = `cmd-text${tone === 'warn' ? ' warn' : ''}`;
  typeInto(el, `> ${text}`, { cps: 70, cursor: tone === 'warn' ? 'amber' : 'hi', keepCursor: true });
}

function errorOf(result: PanelResult): string {
  return (result.body && typeof result.body.error === 'string' && result.body.error) || `HTTP ${result.status}`;
}

/** Chama o método e narra o resultado na linha de comando; devolve o corpo ou `null`. */
async function run(label: string, method: string, ...args: unknown[]): Promise<any | null> {
  const result = await window.panel.call(method, ...args);
  if (!result.ok) {
    say(`${label} ... FALHA: ${errorOf(result)}`, 'warn');
    return null;
  }
  say(`${label} ... OK`);
  return result.body ?? {};
}

// ─── formatação ──────────────────────────────────────────────────────────

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function formatAgo(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `HÁ ${s}S`;
  if (s < 3600) return `HÁ ${Math.floor(s / 60)} MIN`;
  if (s < 86400) return `HÁ ${Math.floor(s / 3600)}H`;
  return `HÁ ${Math.floor(s / 86400)}D`;
}

/** `25.09 06:30` */
function formatStamp(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `04D 11H 23M` */
function formatUptime(seconds: number): string {
  return `${pad(Math.floor(seconds / 86400))}D ${pad(Math.floor((seconds % 86400) / 3600))}H ${pad(Math.floor((seconds % 3600) / 60))}M`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const REPEAT_LABELS: Record<string, string> = {
  daily: 'DIÁRIO',
  weekdays: 'SEG–SEX',
  weekend: 'SÁB · DOM',
  mon: 'SEMANAL · SEG',
  tue: 'SEMANAL · TER',
  wed: 'SEMANAL · QUA',
  thu: 'SEMANAL · QUI',
  fri: 'SEMANAL · SEX',
  sat: 'SEMANAL · SÁB',
  sun: 'SEMANAL · DOM',
};
/** `kind` da API é `once`/`recurring`; o tipo que se mostra vem de ter rótulo ou não. */
const reminderType = (r: { label: string | null }): string => (r.label ? 'LEMBRETE' : 'ALARME');
const DOMAIN_LABELS: Record<string, string> = {
  light: 'LUZ',
  switch: 'INTERRUPTOR',
  fan: 'VENTILADOR',
  climate: 'CLIMATIZADOR',
  cover: 'CORTINA',
  media_player: 'MÍDIA',
};

type Light = 'ok' | 'error' | 'unknown' | 'off';

/** Semáforo: o glifo e a palavra bastam sozinhos; a cor só reforça. */
function lightText(light: Light): { text: string; cls: string } {
  switch (light) {
    case 'ok':
      return { text: '▣ OK', cls: 'hi' };
    case 'error':
      return { text: '◈ FALHA', cls: 'amber' };
    case 'off':
      return { text: '— DESLIGADO', cls: 'fg' };
    default:
      return { text: '░ DESCONHECIDO', cls: 'fg' };
  }
}

// ─── componentes ─────────────────────────────────────────────────────────

function frame(title: string, opts: { tone?: 'warn' | 'muted' | 'danger' | 'lock'; class?: string; style?: string } = {}, ...children: Child[]): HTMLElement {
  const label = opts.tone === 'danger' ? `╔═ ${title} ═╗` : `╞═ ${title} ═╡`;
  return h(
    'div',
    { class: `frame${opts.tone ? ` ${opts.tone}` : ''}${opts.class ? ` ${opts.class}` : ''}`, style: opts.style },
    h('div', { class: 'frame-title' }, label),
    ...children,
  );
}

function kv(label: string, value: Child, valueClass = ''): HTMLElement {
  return h('div', { class: 'kv' }, h('span', {}, label), h('span', { class: 'lead' }), h('span', { class: `val ${valueClass}` }, value));
}

function cmd(label: string, onclick: (e: MouseEvent) => void, opts: { tone?: 'amber' | 'red' | 'quiet'; disabled?: boolean; first?: boolean; ariaLabel?: string; raw?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: `cmd${opts.tone ? ` ${opts.tone}` : ''}${opts.first ? ' first' : ''}`,
      disabled: opts.disabled,
      'aria-label': opts.ariaLabel,
      onclick,
    },
    opts.raw ? label : `[ ${label} ]`,
  ) as HTMLButtonElement;
}

function applies(when: 'immediate' | 'next_session' | string): HTMLElement {
  const text = when === 'immediate' ? 'IMEDIATO' : when === 'next_session' ? 'PRÓXIMA SESSÃO' : when;
  return h('span', { class: 'applies' }, `APLICA: ${text}`);
}

function grid(columns: string, attrs: Record<string, unknown>, ...children: Child[]): HTMLElement {
  const el = h('div', attrs, ...children);
  el.style.gridTemplateColumns = columns;
  return el;
}

/**
 * Rótulo | controle | APLICA. Com `below`, o APLICA desce para baixo do
 * controle — para colunas estreitas, onde a terceira coluna esmagaria o campo.
 */
function field(label: string, control: Node, when: string, labelWidth = 100, below = false): HTMLElement {
  if (below) {
    const tag = applies(when);
    tag.style.textAlign = 'left';
    const el = h('div', { class: 'field', style: 'gap:4px 8px' }, h('span', {}, label), control, h('span'), tag);
    el.style.gridTemplateColumns = `${labelWidth}px minmax(0,1fr)`;
    return el;
  }
  const el = h('div', { class: 'field' }, h('span', {}, label), control, applies(when));
  el.style.gridTemplateColumns = `${labelWidth}px minmax(0,1fr) 104px`;
  return el;
}

function lineInput(value: string, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'line-input', value, spellcheck: 'false', autocomplete: 'off', ...attrs }) as HTMLInputElement;
}

/** `‹ VALOR ›` — percorre uma lista fechada de opções. */
function cycler<T>(options: Array<{ value: T; label: string; raw?: boolean }>, current: number, onChange: (value: T, index: number) => void, name: string): HTMLElement {
  let index = Math.max(0, current);
  const label = h('span', { class: 'cycler-value' });
  const paint = (): void => {
    const opt = options[index];
    label.textContent = opt ? opt.label : '—';
    label.classList.toggle('raw', Boolean(opt?.raw));
  };
  const move = (delta: number): void => {
    if (options.length === 0) return;
    index = (index + delta + options.length) % options.length;
    paint();
    onChange(options[index]!.value, index);
  };
  paint();
  return h(
    'div',
    { class: 'cycler' },
    cmd('‹', () => move(-1), { raw: true, first: true, ariaLabel: `${name} anterior` }),
    label,
    cmd('›', () => move(1), { raw: true, ariaLabel: `próximo ${name}` }),
  );
}

// Um único pedido de confirmação (S/N) e uma única edição cancelável (ESC)
// por vez, na tela inteira — as teclas globais consultam estes dois.
// `pendingConfirm.el` amarra a confirmação à linha visível: um render
// descartado (usuário trocou de tela no meio) não deixa um S/N armado às cegas.
let pendingConfirm: { yes: () => void; no: () => void; el: HTMLElement } | null = null;

function liveConfirm(): typeof pendingConfirm {
  if (pendingConfirm && !pendingConfirm.el.isConnected) pendingConfirm = null;
  return pendingConfirm;
}
let pendingEscape: (() => void) | null = null;

/** Linha âmbar "PERGUNTA? (S/N)█ [ S ] [ N ]". Destrutivo sempre pede isto. */
function confirmLine(question: string, labels: { yes: string; no: string }, onYes: () => void, onNo: () => void, big = false): HTMLElement {
  let answered = false;
  const finish = (fn: () => void) => () => {
    // Um só disparo: clique duplo em [ S ] não reinicia o núcleo duas vezes.
    if (answered) return;
    answered = true;
    if (pendingConfirm?.el === row) pendingConfirm = null;
    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    fn();
  };
  const yes = finish(onYes);
  const no = finish(onNo);
  const q = typed('span', { class: big ? 'display amber' : '', style: big ? 'font-size:28px;line-height:28px;letter-spacing:.04em' : '' }, question, { cps: 45, cursor: 'amber', keepCursor: true });
  const row = h(
    'div',
    { class: 'confirm' },
    q,
    h('span', { class: 'spacer' }),
    cmd(labels.yes, yes, { tone: 'amber', raw: true }),
    cmd(labels.no, no, { tone: 'amber', raw: true }),
  );
  pendingConfirm = { yes, no, el: row };
  return row;
}

/**
 * Segredo: só a máscara (`••••••••` + os 4 últimos caracteres, quando o
 * servidor os dá). [ SUBSTITUIR ] troca por um campo de senha; ENTER grava,
 * ESC desiste. O valor nunca volta para a tela.
 */
function secretField(mask: string, placeholder: string, onCommit: (value: string) => Promise<boolean>): HTMLElement {
  const slot = h('div', { class: 'secret' });
  const idle = (): void => {
    slot.replaceChildren(h('span', { class: 'secret-mask' }, mask), cmd('SUBSTITUIR', edit));
  };
  const edit = (): void => {
    const input = h('input', {
      class: 'line-input',
      type: 'password',
      autocomplete: 'off',
      placeholder: `${placeholder} · ENTER`,
      'aria-label': placeholder,
    }) as HTMLInputElement;
    const cancel = (): void => {
      pendingEscape = null;
      idle();
    };
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter') {
        const value = input.value.trim();
        if (!value) return cancel();
        input.disabled = true;
        if (await onCommit(value)) pendingEscape = null;
        else input.disabled = false;
      }
    });
    pendingEscape = cancel;
    slot.replaceChildren(input);
    input.focus();
  };
  idle();
  return slot;
}

function serverMask(secret: { set: boolean; last4?: string | null } | undefined): string {
  if (!secret?.set) return '— NÃO DEFINIDO';
  return `••••••••${secret.last4 ? secret.last4.toUpperCase() : ''}`;
}

// ─── estado do núcleo (poll global) ──────────────────────────────────────

type Link = 'unknown' | 'ok' | 'alert' | 'noaccess' | 'offline' | 'restarting';

const core = {
  link: 'unknown' as Link,
  status: null as any,
  statusAt: 0,
  error: '',
  offlineSince: 0,
  attempts: 0,
  nextPollAt: 0,
};
const POLL_MS = 5000;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

let statusInFlight = false;

async function pollStatus(): Promise<void> {
  if (statusInFlight) return;
  statusInFlight = true;
  if (statusTimer) clearTimeout(statusTimer);
  let result: PanelResult;
  try {
    result = await window.panel.call('server.status');
  } finally {
    statusInFlight = false;
  }
  if (statusTimer) clearTimeout(statusTimer);
  const wasOffline = core.link === 'offline';
  if (result.ok) {
    core.status = result.body;
    core.statusAt = Date.now();
    const anyFail = Object.values(result.body.connections ?? {}).some((c: any) => c.light === 'error');
    if (restart.phase !== 'count') core.link = anyFail ? 'alert' : 'ok';
    core.attempts = 0;
    core.offlineSince = 0;
  } else if (result.body?.offline) {
    core.error = errorOf(result);
    if (restart.phase !== 'count') {
      if (!core.offlineSince) core.offlineSince = Date.now();
      core.attempts += 1;
      core.link = 'offline';
    }
  } else {
    core.error = errorOf(result);
    core.link = 'noaccess';
  }
  core.nextPollAt = Date.now() + POLL_MS;
  statusTimer = setTimeout(() => void pollStatus(), POLL_MS);
  paintCore();
  if (wasOffline && core.link !== 'offline') {
    say('ENLACE COM O NÚCLEO ... RESTABELECIDO');
    void renderCurrent(true);
  }
}

function paintCore(): void {
  const badge = $('status-badge');
  const map: Record<Link, [string, string]> = {
    unknown: ['░ STATUS: CONSULTANDO', ''],
    ok: ['▣ STATUS: NOMINAL', 'ok'],
    alert: ['▲ STATUS: ALERTA', 'warn'],
    noaccess: ['◈ STATUS: SEM ACESSO', 'warn'],
    offline: ['◈ STATUS: SEM SINAL', 'crit'],
    restarting: ['░ STATUS: REINICIANDO', 'warn'],
  };
  const [text, cls] = map[core.link];
  badge.textContent = text;
  badge.className = `status-badge ${cls}`;

  // "Este terminal" continua acessível sem núcleo: é lá que se corrige a URL.
  const offline = core.link === 'offline' && currentPage?.id !== 'local';
  $('workspace').hidden = offline;
  $('nosignal').hidden = !offline;
  if (offline && !$('nosignal').hasChildNodes()) buildNoSignal();
  if (!offline) $('nosignal').replaceChildren();
  paintClock();
}

function paintClock(): void {
  const now = new Date();
  $('date').textContent = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  $('clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  $('uptime').textContent =
    core.status && core.link !== 'offline' && core.link !== 'restarting'
      ? formatUptime(core.status.uptime_s + Math.floor((Date.now() - core.statusAt) / 1000))
      : '— — — —';

  const facts = document.getElementById('ns-facts');
  if (facts) {
    const since = Math.floor((Date.now() - core.offlineSince) / 1000);
    const next = Math.max(0, Math.ceil((core.nextPollAt - Date.now()) / 1000));
    $('ns-attempt').textContent = pad(core.attempts, 3);
    $('ns-next').textContent = `${pad(next)}S`;
    $('ns-since').textContent = `${pad(Math.floor(since / 3600))}:${pad(Math.floor((since % 3600) / 60))}:${pad(since % 60)}`;
  }
}

function buildNoSignal(): void {
  const headline = h('div', { class: 'headline' });
  $('nosignal').replaceChildren(
    h('div', { class: 'code' }, '◈ FALHA CRÍTICA // SEM ENLACE'),
    headline,
    h(
      'div',
      { class: 'facts', id: 'ns-facts' },
      h('span', {}, 'TENTATIVA'),
      h('span', { id: 'ns-attempt' }),
      h('span', {}, 'PRÓXIMA EM'),
      h('span', { id: 'ns-next' }),
      h('span', {}, 'SEM CONTATO HÁ'),
      h('span', { id: 'ns-since' }),
      h('span', {}, 'ALVO'),
      h('span', { class: 'raw' }, local?.serverUrl ?? '—'),
      h('span', {}, 'MOTIVO'),
      h('span', { class: 'raw' }, core.error),
    ),
    h('div', { class: 'note' }, 'OS SATÉLITES CONTINUAM ESCUTANDO A WAKE WORD.', h('br'), 'A VOZ DA LUNA RETORNA QUANDO O NÚCLEO RESPONDER.'),
    h(
      'div',
      { class: 'row' },
      cmd('TENTAR AGORA', () => {
        say('RECONEXÃO MANUAL ... AGUARDANDO');
        void pollStatus();
      }, { tone: 'red' }),
      cmd('ABRIR ESTE TERMINAL', () => void show('local'), { tone: 'red' }),
    ),
  );
  typeInto(headline, 'SEM SINAL DO NÚCLEO — TENTANDO RECONEXÃO…', { cps: 30, cursor: 'red', keepCursor: true });
}

// ─── satélite local (faixa de voz) ───────────────────────────────────────

let local: any = null;
let micLevel = 0;

function paintLocal(): void {
  if (!local) return;
  $('cmd-meta').textContent = `NÚCLEO ${hostOf(local.serverUrl).toUpperCase()} · OPERADOR ÚNICO`;
  paintVoice();
}

const VOICE_LABELS: Record<string, string> = {
  idle: '— EM ESPERA',
  listening: '◉ ESCUTANDO…',
  thinking: '◌ PROCESSANDO…',
  speaking: '◉ FALANDO…',
  error: '◈ SEM ENLACE',
};

function paintVoice(): void {
  const state: string = local?.state ?? 'error';
  const bar = $('voicebar-root');
  bar.className = `voicebar ${state === 'idle' ? 'idle' : state === 'error' ? 'error' : 'active'}`;
  $('voice-label').textContent = local?.muted && state === 'idle' ? '— MUDO' : VOICE_LABELS[state] ?? state;
  const room = h('span', {}, `${String(local?.roomId ?? '').toUpperCase()} · `, h('span', { class: 'raw' }, local?.deviceId ?? ''));
  $('voice-room').replaceChildren(state === 'idle' ? (local?.muted ? 'MICROFONE FECHADO' : 'AGUARDANDO “HEY LUNA”') : room);
}

/** Pseudo-aleatório estável, para a forma de onda não "ferver". */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const WAVE_CHARS = '▁▂▃▄▅▆▇█';
const WAVE_WIDTH = 160;

function paintWave(): void {
  const state: string = local?.state ?? 'error';
  const el = $('voice-wave');
  if (state === 'idle' || state === 'error') {
    if (el.textContent !== '▁'.repeat(WAVE_WIDTH)) el.textContent = '▁'.repeat(WAVE_WIDTH);
    return;
  }
  const t = reduced() ? 1.3 : performance.now() / 1000;
  // Enquanto escuta, a amplitude segue o nível real do microfone.
  const gain = state === 'listening' ? Math.min(1.4, 0.4 + Math.sqrt(micLevel) * 3) : 1;
  let s = '';
  for (let i = 0; i < WAVE_WIDTH; i++) {
    let v = 0;
    if (state === 'listening') v = (0.18 + 0.4 * Math.abs(Math.sin(i * 0.55 + t * 7)) * (0.55 + 0.45 * Math.sin(i * 0.17 - t * 2.3)) + 0.18 * hash(i + Math.floor(t * 12) * 7)) * gain;
    else if (state === 'thinking') {
      const c = ((t * 34) % 110) - 10;
      v = 0.05 + 0.9 * Math.exp(-((i % 110 - c) ** 2) / 22);
    } else v = 0.45 + 0.5 * Math.sin(i * 0.42 + t * 11) * Math.sin(i * 0.07 - t * 3.1);
    v = Math.max(0, Math.min(0.999, v));
    s += WAVE_CHARS[Math.floor(v * 8)];
  }
  el.textContent = s;
}

// ─── navegação ───────────────────────────────────────────────────────────

interface Page {
  id: string;
  nav: string;
  title: string;
  soon?: boolean;
  render(root: HTMLElement): Promise<void>;
  /** Recarrega sozinho enquanto a página está aberta. */
  pollMs?: number;
  /** Saindo da página: solta o que ela segura aberto (o stream de log). */
  leave?(): void;
}

const pages: Page[] = [];
let currentPage: Page | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Descarta respostas de uma página que o usuário já trocou. */
let renderSeq = 0;

/** Subtítulo à direita do título; `raw` para quando é um identificador técnico. */
function setMeta(text: string, raw = false): void {
  const el = $('screen-meta');
  el.textContent = text;
  el.classList.toggle('raw', raw);
}

async function show(id: string): Promise<void> {
  const page = pages.find((p) => p.id === id) ?? pages[0]!;
  const changed = page !== currentPage;
  if (changed) currentPage?.leave?.();
  currentPage = page;
  if (location.hash !== `#${page.id}`) history.replaceState(null, '', `#${page.id}`);
  const index = pages.indexOf(page);
  $('screen-num').textContent = `${pad(index + 1)} //`;
  if (changed) {
    // Sair da tela desiste de qualquer confirmação ou edição em curso.
    pendingConfirm = null;
    pendingEscape = null;
    confirmingReminder = null;
    if (restart.phase === 'confirm') restart.phase = 'idle';
    typeInto($('screen-title'), page.title, { cps: 45, cursor: 'hi' });
    setMeta('');
    say(page.soon ? `ABRIR ${pad(index + 1)} ${page.nav} ... ACESSO NEGADO` : `ABRIR ${pad(index + 1)} ${page.nav} ... OK`, page.soon ? 'warn' : 'ok');
  }
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((btn) => {
    const active = btn.dataset.page === page.id;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  paintCore();
  await renderCurrent();
  if (page.pollMs) pollTimer = setInterval(() => void renderCurrent(true), page.pollMs);
}

async function renderCurrent(quiet = false): Promise<void> {
  const page = currentPage;
  if (!page) return;
  // Não repinta por cima de uma edição, confirmação ou campo em foco.
  const busy = (): boolean => {
    const active = document.activeElement;
    return Boolean(liveConfirm() || pendingEscape || (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName) && $('page').contains(active)));
  };
  if (quiet && busy()) return;
  const seq = ++renderSeq;
  const root = h('div', { class: 'page-body', style: 'display:flex;flex-direction:column;flex:1;min-height:0' });
  try {
    await page.render(root);
  } catch (err) {
    root.append(h('div', { class: 'alert' }, h('span', { class: 'alert-title' }, '◈ FALHA AO CARREGAR'), h('span', { class: 'raw' }, String(err))));
  }
  if (seq !== renderSeq) return;
  if (quiet && busy()) return;
  $('page').replaceChildren(root);
}

/** O servidor recusou ou não está configurado: explica e aponta para onde se resolve. */
function serverUnavailable(root: HTMLElement, result: PanelResult): void {
  root.append(
    h(
      'div',
      { class: 'alert', style: 'margin-top:8px' },
      h('span', { class: 'alert-title' }, '▲ NÚCLEO INACESSÍVEL POR ESTE PAINEL'),
      h('span', { style: 'font-size:12px' }, errorOf(result)),
      h('div', { class: 'row', style: 'margin-top:6px' }, cmd('ABRIR ESTE TERMINAL', () => void show('local'), { tone: 'amber', first: true })),
    ),
  );
}

// ─── 01 Início ───────────────────────────────────────────────────────────

const LINK_LABELS: Array<[string, string]> = [
  ['ha', 'HOME ASSISTANT'],
  ['provider', 'PROVEDOR DE IA'],
  ['weather', 'CLIMA'],
  ['calendar', 'AGENDA'],
];

pages.push({
  id: 'home',
  nav: 'INÍCIO',
  title: 'VISÃO GERAL DO SISTEMA',
  pollMs: 5000,
  async render(root) {
    const [statusRes, satsRes, providerRes, errorsRes] = await Promise.all([
      window.panel.call('server.status'),
      window.panel.call('server.satellites'),
      window.panel.call('server.settings', 'provider'),
      window.panel.call('server.errors', 5),
    ]);
    setMeta('RESUMO DO NÚCLEO E ENLACES');
    if (!statusRes.ok) return serverUnavailable(root, statusRes);
    const status = statusRes.body;
    const sats = (satsRes.ok ? satsRes.body.satellites : []) as any[];

    const failing = LINK_LABELS.filter(([key]) => status.connections?.[key]?.light === 'error').map(([, label]) => label);
    if (failing.length > 0) {
      root.append(
        h(
          'div',
          { class: 'banner', style: 'margin-bottom:16px' },
          h('span', {}, `▲ ATENÇÃO: ENLACE ${failing.join(' E ')} PERDIDO`),
          h('span', { class: 'spacer' }),
          cmd('ABRIR INTEGRAÇÕES', () => void show('integrations')),
        ),
      );
    }

    const provider = providerRes.ok ? providerRes.body.value : null;
    const providerText = provider
      ? h(
          'span',
          {},
          `${provider.provider === 'openai' ? 'OPENAI' : 'GEMINI'} · `,
          h('span', { class: 'raw' }, provider.provider === 'openai' ? provider.openaiVoice : provider.geminiLiveModel),
        )
      : '—';

    const nucleus = frame(
      'NÚCLEO',
      {},
      kv('SERVIDOR', '▣ ONLINE'),
      kv('VERSÃO', h('span', { class: 'raw' }, `v${status.version}`)),
      kv('UPTIME', formatUptime(status.uptime_s)),
      kv('ENDEREÇO', h('span', { class: 'raw' }, local ? hostOf(local.serverUrl) : '—')),
      kv('PROVEDOR ATIVO', providerText),
    );

    const linkCols = '150px 130px minmax(0,1fr)';
    const links = frame(
      'ENLACES',
      { tone: failing.length ? 'warn' : undefined },
      grid(linkCols, { class: 'tbl-head' }, h('span', {}, 'CONEXÃO'), h('span', {}, 'ESTADO'), h('span', {}, 'DETALHE')),
      ...LINK_LABELS.map(([key, label]) => {
        const conn = status.connections?.[key] ?? { light: 'unknown', detail: '' };
        const light = lightText(conn.light);
        return grid(linkCols, { class: 'tbl-row' }, h('span', {}, label), h('span', { class: light.cls }, light.text), h('span', { class: `${light.cls} ellipsis` }, conn.detail));
      }),
    );

    const online = sats.filter((s) => s.online);
    const satCols = '116px 110px minmax(0,1fr)';
    const satellites = frame(
      'SATÉLITES ATIVOS',
      {},
      h(
        'div',
        { class: 'row', style: 'align-items:baseline;gap:12px' },
        h('span', { class: 'display', style: 'font-size:40px;line-height:36px;letter-spacing:.04em' }, `${online.length}/${sats.length}`),
        h('span', {}, online.length ? `ONLINE — ${[...new Set(online.map((s) => s.room_id))].join(', ')}` : 'NENHUM SATÉLITE ONLINE'),
      ),
      ...sats.map((s) =>
        grid(
          satCols,
          { class: `tbl-row ${s.online ? 'hi' : 'fg'}` },
          h('span', {}, s.online ? '▣ ONLINE' : '— OFFLINE'),
          h('span', { class: 'ellipsis' }, s.name ?? s.room_id ?? '—'),
          h('span', { class: 'raw ellipsis' }, s.device_id),
        ),
      ),
    );

    const next = status.next_reminders as any[];
    const evCols = '100px 110px 84px minmax(0,1fr)';
    const events = frame(
      'PRÓXIMOS EVENTOS',
      {},
      grid(evCols, { class: 'tbl-head' }, h('span', {}, 'HORÁRIO'), h('span', {}, 'SALA'), h('span', {}, 'TIPO'), h('span', {}, 'RÓTULO')),
      ...next.map((r) =>
        grid(
          evCols,
          { class: 'tbl-row' },
          h('span', { class: 'hi' }, formatStamp(r.next_due_utc)),
          h('span', { class: 'ellipsis' }, r.room_id),
          h('span', {}, reminderType(r)),
          h('span', { class: 'hi ellipsis' }, r.label ?? 'ALARME'),
        ),
      ),
      next.length === 0 ? h('div', {}, 'NENHUM EVENTO AGENDADO. A TRIPULAÇÃO ESTÁ LIVRE.') : null,
    );

    // Servidor antigo (sem a rota) não quebra a tela: o quadro só não aparece.
    const recentErrors = errorsRes.ok ? (errorsRes.body.errors as any[]) : null;
    const errCols = '100px 190px minmax(0,1fr)';
    const errorsFrame = recentErrors
      ? frame(
          'ÚLTIMOS ERROS',
          { tone: recentErrors.length ? 'warn' : undefined, style: 'grid-column:1 / -1;gap:0' },
          ...recentErrors.map((e) =>
            grid(errCols, { class: 'tbl-row' }, h('span', { class: 'amber' }, formatStamp(e.at)), h('span', { class: 'raw ellipsis' }, e.event ?? '—'), h('span', { class: 'raw ellipsis', title: e.msg }, `${e.room_id ? `${e.room_id} · ` : ''}${e.msg}`)),
          ),
          recentErrors.length === 0 ? h('div', {}, 'NENHUM ERRO REGISTRADO.') : null,
          recentErrors.length ? h('div', { class: 'row', style: 'padding-top:6px' }, h('span', { class: 'spacer' }), cmd('ABRIR DIAGNÓSTICO', () => void show('diagnostics'), { tone: 'quiet' })) : null,
        )
      : null;

    root.append(h('div', { class: 'cols', style: 'grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)' }, nucleus, links, satellites, events, errorsFrame));
  },
});

// ─── 02 Satélites ────────────────────────────────────────────────────────

let selectedSatellite: string | null = null;
let editingSatellite: string | null = null;

pages.push({
  id: 'satellites',
  nav: 'SATÉLITES',
  title: 'SATÉLITES REGISTRADOS',
  pollMs: 10000,
  async render(root) {
    const result = await window.panel.call('server.satellites');
    if (!result.ok) return serverUnavailable(root, result);
    const sats = result.body.satellites as any[];
    const online = sats.filter((s) => s.online).length;
    setMeta(`${sats.length} REGISTRADOS · ${online} ONLINE`);
    if (sats.length === 0) {
      root.append(emptyReport('RELATÓRIO DE SATÉLITES // 0 REGISTROS', 'NENHUM SATÉLITE CONECTOU DESDE QUE O NÚCLEO LIGOU.', 'LIGUE UM SATÉLITE NA MESMA REDE E ELE APARECE AQUI SOZINHO.'));
      return;
    }
    if (!sats.some((s) => s.device_id === selectedSatellite)) selectedSatellite = sats[0].device_id;

    const cols = '150px 150px 100px 96px 100px minmax(0,1fr)';
    const rows = sats.map((s) => {
      const selected = s.device_id === selectedSatellite;
      let nameCell: HTMLElement;
      if (editingSatellite === s.device_id) {
        const input = h('input', { class: 'box-input', value: s.name ?? '', maxLength: 64, 'aria-label': 'Nome amigável', style: 'width:100%' }) as HTMLInputElement;
        let done = false;
        const commit = async (): Promise<void> => {
          if (done) return;
          done = true;
          pendingEscape = null;
          editingSatellite = null;
          const name = input.value.trim();
          if (name !== (s.name ?? '')) await run(`RENOMEAR ${s.device_id} "${name.toUpperCase() || 'SEM NOME'}"`, 'server.renameSatellite', s.device_id, name || null);
          void renderCurrent();
        };
        const cancel = (): void => {
          done = true;
          pendingEscape = null;
          editingSatellite = null;
          void renderCurrent();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') cancel();
        });
        input.addEventListener('blur', () => void commit());
        input.addEventListener('click', (e) => e.stopPropagation());
        pendingEscape = cancel;
        queueMicrotask(() => input.focus());
        nameCell = h('div', { style: 'min-width:0' }, input);
      } else {
        nameCell = h(
          'div',
          { style: 'min-width:0' },
          cmd(`${s.name ?? '— SEM NOME —'} ✎`, (e) => {
            e.stopPropagation();
            selectedSatellite = s.device_id;
            editingSatellite = s.device_id;
            void renderCurrent();
          }, { raw: true, ariaLabel: `Renomear ${s.device_id}` }),
        );
        (nameCell.firstChild as HTMLElement).style.cssText = 'color:inherit;margin-left:-4px;cursor:text;max-width:100%;overflow:hidden;text-overflow:ellipsis';
      }
      return grid(
        cols,
        {
          class: `tbl-row sel${selected ? ' selected' : ''}${s.online ? '' : ' offline'}`,
          onclick: () => {
            selectedSatellite = s.device_id;
            void renderCurrent();
          },
        },
        h('span', { class: 'raw nowrap ellipsis' }, `${selected ? '►' : ' '} ${s.device_id}`),
        nameCell,
        h('span', { class: 'ellipsis' }, s.room_id ?? '—'),
        h('span', { class: s.online ? 'hi' : 'fg' }, s.online ? '▣ ONLINE' : '— OFFLINE'),
        h('span', {}, s.online ? formatStamp(s.connected_since) : '—'),
        h('span', {}, formatAgo(s.last_seen_at)),
      );
    });

    const table = h(
      'div',
      { class: 'tbl', style: 'flex:1;min-width:0' },
      grid(cols, { class: 'tbl-head strong' }, h('span', {}, 'DEVICE_ID'), h('span', {}, 'NOME'), h('span', {}, 'SALA'), h('span', {}, 'ESTADO'), h('span', {}, 'CONECTADO DESDE'), h('span', {}, 'ÚLTIMO SINAL')),
      ...rows,
      h(
        'div',
        { class: 'tbl-foot' },
        h('span', {}, `${sats.length} SATÉLITES · ${online} ONLINE · ${sats.length - online} OFFLINE`),
        h('span', { class: 'spacer' }),
        h('span', {}, 'CLIQUE NO NOME PARA RENOMEAR · ENTER SALVA · ESC CANCELA'),
      ),
    );

    const sel = sats.find((s) => s.device_id === selectedSatellite)!;
    const future = (label: string): HTMLElement => grid('96px 1fr', { class: 'grid dim', style: 'align-items:start' }, h('span', {}, label), h('span', {}, 'INDISPONÍVEL NESTA VERSÃO'));
    const detail = frame(
      'DETALHE',
      { style: 'width:260px;flex-shrink:0;align-self:flex-start;margin-top:8px;gap:8px' },
      h('div', { class: 'display', style: 'font-size:26px;letter-spacing:.06em' }, sel.name ?? '— SEM NOME —'),
      kv('DEVICE_ID', h('span', { class: 'raw' }, sel.device_id)),
      kv('SALA', sel.room_id ?? '—'),
      kv('ESTADO', sel.online ? '▣ ONLINE' : '— OFFLINE', sel.online ? '' : 'fg'),
      kv('CONECTADO DESDE', sel.online ? formatStamp(sel.connected_since) : '—'),
      kv('ÚLTIMO SINAL', formatAgo(sel.last_seen_at)),
      h('div', { class: 'dim small', style: 'margin-top:8px' }, '── RECURSOS FUTUROS ──────────'),
      future('FIRMWARE'),
      future('IP'),
      future('SINAL WI-FI'),
      cmd('IDENTIFICAR', () => undefined, { disabled: true, first: true }),
    );

    root.append(h('div', { style: 'display:flex;gap:18px;flex:1;min-height:0' }, table, detail));
  },
});

function emptyReport(kicker: string, headline: string, hint: string): HTMLElement {
  return h(
    'div',
    { class: 'empty-report' },
    h(
      'div',
      {},
      h('span', { class: 'small' }, kicker),
      typed('span', { class: 'display', style: 'font-size:30px;line-height:32px;letter-spacing:.06em' }, headline, { cps: 40, delayMs: 400, cursor: 'hi', keepCursor: true }),
      h('span', { style: 'font-size:12px;line-height:1.7' }, hint),
    ),
  );
}

// ─── 03 Salas e dispositivos ─────────────────────────────────────────────

let selectedRoom: string | null = null;
let aliasTarget: string | null = null;
let mapTimer: ReturnType<typeof setTimeout> | null = null;

pages.push({
  id: 'rooms',
  nav: 'SALAS',
  title: 'SALAS E DISPOSITIVOS',
  async render(root) {
    const [roomsRes, devicesRes] = await Promise.all([window.panel.call('server.rooms'), window.panel.call('server.devices')]);
    setMeta('SALAS VINDAS DOS SATÉLITES E DO HA');
    if (!roomsRes.ok) return serverUnavailable(root, roomsRes);
    const { rooms: all, ha_areas: haAreas } = roomsRes.body as { rooms: any[]; ha_areas: string[] };
    const aliases: Record<string, string> = devicesRes.ok ? { ...(devicesRes.body.aliases ?? {}) } : {};

    // "Salas da Luna": onde há satélite ou mapeamento. Área do HA que nenhuma
    // delas usa é órfã — a Luna só a alcança de um satélite dentro dela.
    const rooms = all.filter((r) => r.has_satellite || r.area);
    const used = new Set(rooms.map((r) => r.effective_area).filter(Boolean));
    const orphans = haAreas.filter((a) => !used.has(a));

    if (rooms.length === 0) {
      root.append(emptyReport('RELATÓRIO DE SALAS // 0 REGISTROS', 'NENHUMA SALA COM SATÉLITE.', 'AS SALAS APARECEM QUANDO UM SATÉLITE CONECTA COM O SEU ROOM_ID.'));
      return;
    }
    if (!rooms.some((r) => r.room_id === selectedRoom)) selectedRoom = rooms[0].room_id;
    const room = rooms.find((r) => r.room_id === selectedRoom)!;

    const list = frame(
      'SALAS DA LUNA',
      { style: 'padding:18px 8px 8px;gap:2px' },
      ...rooms.map((r) => {
        const selected = r.room_id === selectedRoom;
        const area = r.effective_area;
        const btn = h(
          'button',
          {
            type: 'button',
            class: `cmd room-btn${selected ? ' selected' : ''}${area ? '' : ' unmapped'}`,
            onclick: () => {
              selectedRoom = r.room_id;
              aliasTarget = null;
              void renderCurrent();
            },
          },
          h('span', {}, selected ? '►' : area ? '▣' : '◈'),
          h('span', { class: 'ellipsis' }, r.room_id),
          h('span'),
          h('span', { class: 'small ellipsis' }, area ? `↔ ${area}${r.area ? '' : ' (PRÓPRIA)'}` : '◈ SEM ÁREA'),
        );
        return btn;
      }),
    );
    const orphanFrame = frame(
      'ÁREAS ÓRFÃS DO HA',
      { tone: 'muted', style: 'padding:18px 14px 12px;gap:6px' },
      ...orphans.map((a) => h('div', { class: 'row', style: 'gap:8px' }, h('span', {}, '░'), h('span', { class: 'ellipsis' }, a))),
      orphans.length === 0 ? h('div', {}, 'NENHUMA. INVENTÁRIO COMPLETO.') : null,
    );

    // Mapeamento: ‹ › percorre as áreas; grava meio segundo depois do último clique.
    const options: Array<{ value: string | null; label: string }> = [
      { value: null, label: room.is_ha_area ? 'A PRÓPRIA ÁREA' : '— NENHUMA —' },
      ...haAreas.filter((a) => a !== room.room_id).map((a) => ({ value: a as string | null, label: a })),
    ];
    // Mapeada para uma área que o HA não tem mais: mostra como está, não como "nenhuma".
    if (room.area && !haAreas.includes(room.area)) options.push({ value: room.area, label: `${room.area} (FORA DO HA)` });
    const current = options.findIndex((o) => o.value === room.area);
    const areaCycler = cycler(options, current, (value) => {
      if (mapTimer) clearTimeout(mapTimer);
      mapTimer = setTimeout(async () => {
        const body = await run(value ? `MAPEAR ${room.room_id} ↔ ${value}` : `DESMAPEAR ${room.room_id}`, 'server.mapRoom', room.room_id, value);
        if (body) void renderCurrent();
      }, 500);
    }, 'área');
    areaCycler.querySelector('.cycler-value')!.classList.add('display');
    (areaCycler.querySelector('.cycler-value') as HTMLElement).style.cssText = 'font-size:28px;line-height:28px;min-width:190px;text-align:center;letter-spacing:.06em';

    const mapping = frame(
      'ÁREA DO HA ↔ SALA DA LUNA',
      {},
      h(
        'div',
        { class: 'row', style: 'align-items:flex-end;gap:18px' },
        h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, h('span', { class: 'small' }, 'SALA DA LUNA'), h('span', { class: 'display', style: 'font-size:28px;letter-spacing:.06em' }, room.room_id)),
        h('span', { class: 'display fg', style: 'font-size:28px' }, '↔'),
        h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, h('span', { class: 'small' }, 'ÁREA DO HOME ASSISTANT'), areaCycler),
        h('span', { class: 'spacer' }),
        applies('immediate'),
      ),
    );

    const unmapped = room.effective_area
      ? null
      : h(
          'div',
          { class: 'alert', style: 'margin-top:-8px' },
          h('span', { class: 'alert-title' }, '▲ SALA SEM ÁREA — COMANDOS PODEM FALHAR'),
          h('span', { style: 'font-size:12px' }, `A LUNA NÃO SABE QUE DISPOSITIVOS FICAM EM ${room.room_id.toUpperCase()}. ESCOLHA UMA ÁREA DO HOME ASSISTANT ACIMA.`),
        );

    const saveAliases = async (next: Record<string, string>, label: string): Promise<void> => {
      if (await run(label, 'server.saveAliases', next)) void renderCurrent();
    };
    const devCols = '110px 240px minmax(0,1fr)';
    const devices = frame(
      'O QUE A LUNA ENXERGA AQUI',
      { style: 'gap:0' },
      grid(devCols, { class: 'tbl-head' }, h('span', {}, 'TIPO'), h('span', {}, 'DISPOSITIVO / ENTITY_ID'), h('span', {}, 'APELIDOS')),
      ...(room.devices as any[]).map((d) => {
        const domain = String(d.entity_id).split('.')[0] ?? '';
        const chips = Object.entries(aliases)
          .filter(([, target]) => target === d.device)
          .map(([alias]) =>
            h(
              'span',
              { class: 'chip' },
              alias,
              cmd('×', () => {
                const next = { ...aliases };
                delete next[alias];
                void saveAliases(next, `REMOVER APELIDO "${alias.toUpperCase()}"`);
              }, { raw: true, ariaLabel: `Remover apelido ${alias}` }),
            ),
          );
        let adder: HTMLElement;
        if (aliasTarget === d.device) {
          const input = h('input', { class: 'box-input', placeholder: 'NOVO APELIDO', 'aria-label': 'Novo apelido', maxLength: 64, style: 'width:150px;font-size:12px;padding:1px 6px' }) as HTMLInputElement;
          let done = false;
          const close = (): void => {
            done = true;
            pendingEscape = null;
            aliasTarget = null;
          };
          const commit = (): void => {
            if (done) return;
            const alias = input.value.trim();
            close();
            if (alias && aliases[alias] !== d.device) void saveAliases({ ...aliases, [alias]: d.device }, `APELIDO "${alias.toUpperCase()}" → ${d.device}`);
            else void renderCurrent();
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              close();
              void renderCurrent();
            }
          });
          input.addEventListener('blur', commit);
          pendingEscape = () => {
            close();
            void renderCurrent();
          };
          queueMicrotask(() => input.focus());
          adder = input;
        } else {
          adder = cmd('+ APELIDO', () => {
            aliasTarget = d.device;
            void renderCurrent();
          }, { tone: 'quiet' });
          adder.style.fontSize = '12px';
        }
        return grid(
          devCols,
          { class: 'tbl-row dotted' },
          h('span', {}, DOMAIN_LABELS[domain] ?? domain.toUpperCase()),
          h('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:0' }, h('span', { class: 'hi ellipsis' }, d.name ?? d.device), h('span', { class: 'raw small ellipsis' }, d.entity_id)),
          h('div', { class: 'chips' }, ...chips, adder),
        );
      }),
      room.devices.length === 0 ? h('div', { class: 'amber', style: 'padding:14px 0 6px' }, 'NENHUM DISPOSITIVO VISÍVEL. SEM ÁREA, SEM INVENTÁRIO.') : null,
    );

    root.append(
      h(
        'div',
        { style: 'display:flex;gap:18px;padding-top:8px' },
        h('div', { style: 'width:240px;flex-shrink:0;display:flex;flex-direction:column;gap:24px' }, list, orphanFrame),
        h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:22px' }, mapping, unmapped, devices),
      ),
    );
  },
});

// ─── 04 Integrações ──────────────────────────────────────────────────────

const URL_PATTERN = /^https?:\/\/[^\s/:]+(:\d{1,5})?(\/\S*)?$/i;

function urlError(value: string): string | null {
  if (!value.trim()) return 'CAMPO OBRIGATÓRIO';
  if (!URL_PATTERN.test(value.trim())) return 'URL INVÁLIDA — FORMATO ESPERADO: HTTP://HOST:PORTA';
  return null;
}

/** Moldura de uma integração com URL + credencial + teste de conexão (HA, agenda). */
function connectionFrame(opts: {
  group: 'ha' | 'calendar';
  title: string;
  secretLabel: string;
  value: { url: string; token: { set: boolean; last4?: string | null } };
  light: { light: Light; detail: string } | undefined;
  note?: string;
}): HTMLElement {
  const { group, title } = opts;
  const url = lineInput(opts.value.url ?? '', { 'aria-label': `URL — ${title}`, placeholder: 'HTTP://HOST:PORTA' });
  const urlErr = h('div', { class: 'field-error', hidden: true });
  const validate = (): string | null => {
    const err = urlError(url.value);
    url.classList.toggle('invalid', Boolean(err));
    urlErr.hidden = !err;
    urlErr.textContent = err ? `◈ ${err}` : '';
    box.classList.toggle('warn', Boolean(err) || opts.light?.light === 'error');
    return err;
  };
  url.addEventListener('input', validate);

  const lightInfo = lightText(opts.light?.light ?? 'unknown');
  const state = h('span', { class: lightInfo.cls }, `${lightInfo.text}${opts.light?.detail ? ` — ${opts.light.detail}` : ''}`);
  const log = h('div', { class: 'log' }, h('div', {}, '> AGUARDANDO COMANDO.'));
  const logLine = (text: string, tone: '' | 'ok' | 'warn' = ''): void => {
    const line = h('div', { class: tone });
    log.append(line);
    typeInto(line, text, { cps: 70 });
  };

  const actions = h('div', { class: 'row' });
  const test = cmd('TESTAR CONEXÃO', async () => {
    if (validate()) {
      say(`TESTE ${title} ... RECUSADO: URL INVÁLIDA`, 'warn');
      return;
    }
    test.disabled = true;
    test.textContent = '[ TESTANDO… ]';
    state.className = 'fg';
    state.textContent = '░ TESTANDO…';
    log.replaceChildren();
    logLine(`> CONECTANDO A ${hostOf(url.value.trim()).toUpperCase()}…`);
    const result = await window.panel.call('server.testConnection', group, { url: url.value.trim() });
    const body = result.body ?? {};
    const ok = result.ok && body.ok;
    const error = result.ok ? body.error : errorOf(result);
    logLine(ok ? `> OK (${body.latency_ms}MS)` : `> ◈ FALHA: ${error}`, ok ? 'ok' : 'warn');
    state.className = ok ? 'hi' : 'amber';
    state.textContent = ok ? `▣ OK · ${body.latency_ms}MS` : `◈ FALHA — ${error}`;
    box.classList.toggle('warn', !ok);
    say(ok ? `TESTE ${title} ... OK ${body.latency_ms}MS` : `TESTE ${title} ... FALHA: ${error}`, ok ? 'ok' : 'warn');
    test.disabled = false;
    test.textContent = '[ TESTAR CONEXÃO ]';
  }, { first: true });
  const save = cmd('SALVAR', async () => {
    if (validate()) {
      say(`SALVAR ${title} ... RECUSADO: URL INVÁLIDA`, 'warn');
      return;
    }
    if (await run(`SALVAR ${title} · APLICADO A QUENTE`, 'server.saveSettings', group, { url: url.value.trim() })) void renderCurrent();
  });
  actions.append(test, save);

  const box = frame(
    title,
    { tone: opts.light?.light === 'error' ? 'warn' : undefined, style: 'gap:10px' },
    field('URL', url, 'immediate'),
    urlErr,
    field(
      opts.secretLabel,
      secretField(serverMask(opts.value.token), 'COLE O NOVO VALOR', async (token) => {
        const body = await run(`${opts.secretLabel} DE ${title} SUBSTITUÍDO · VALOR NÃO EXIBIDO`, 'server.saveSettings', group, { token });
        if (body) void renderCurrent();
        return Boolean(body);
      }),
      'immediate',
    ),
    grid('78px minmax(0,1fr)', { class: 'grid' }, h('span', {}, 'ESTADO'), state),
    opts.note ? h('div', { class: 'small', style: 'line-height:1.6' }, opts.note) : null,
    actions,
    log,
  );
  box.style.color = 'var(--fg)';
  return box;
}

/** Vozes conhecidas do OpenAI Realtime; a gravada entra na lista se não estiver nela. */
const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];

function providerFrame(saved: any): HTMLElement {
  const draft = { provider: saved.provider as string, geminiLiveModel: saved.geminiLiveModel as string, openaiRealtimeModel: saved.openaiRealtimeModel as string, openaiVoice: saved.openaiVoice as string };
  const container = frame('PROVEDOR DE IA', { style: 'gap:14px' });

  const paint = (): void => {
    const isOpenai = draft.provider === 'openai';
    const radio = (value: string, label: string): HTMLElement => {
      const b = cmd(`${draft.provider === value ? '(•)' : '( )'} ${label}`, () => {
        draft.provider = value;
        paint();
      }, { raw: true });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(draft.provider === value));
      return b;
    };
    const modelKey = isOpenai ? 'openaiRealtimeModel' : 'geminiLiveModel';
    const model = lineInput(draft[modelKey], { 'aria-label': 'Modelo' });
    model.addEventListener('input', () => {
      draft[modelKey] = model.value;
      paintNote();
    });

    const voices = OPENAI_VOICES.includes(draft.openaiVoice) ? OPENAI_VOICES : [draft.openaiVoice, ...OPENAI_VOICES];
    const idx = h('span', { class: 'small' }, `${voices.indexOf(draft.openaiVoice) + 1}/${voices.length}`);
    const voice = isOpenai
      ? h(
          'div',
          { class: 'row', style: 'gap:6px' },
          cycler(voices.map((v) => ({ value: v, label: v.toUpperCase() })), voices.indexOf(draft.openaiVoice), (v, i) => {
            draft.openaiVoice = v;
            idx.textContent = `${i + 1}/${voices.length}`;
            paintNote();
          }, 'voz'),
          idx,
        )
      : h('span', { class: 'fg' }, 'DEFINIDA PELO MODELO');

    const keyName = isOpenai ? 'openaiApiKey' : 'geminiApiKey';
    const note = h('div');
    const paintNote = (): void => {
      const dirty = draft.provider !== saved.provider || draft.geminiLiveModel !== saved.geminiLiveModel || draft.openaiRealtimeModel !== saved.openaiRealtimeModel || draft.openaiVoice !== saved.openaiVoice;
      note.textContent = dirty ? 'ALTERAÇÕES PENDENTES · VALEM A PARTIR DA PRÓXIMA SESSÃO DE VOZ' : 'NENHUMA ALTERAÇÃO PENDENTE';
      note.className = dirty ? 'amber' : '';
    };
    paintNote();

    container.replaceChildren(
      container.firstChild!,
      field('PROVEDOR', h('div', { class: 'row', role: 'radiogroup', style: 'gap:14px' }, radio('gemini', 'GEMINI'), radio('openai', 'OPENAI')), 'next_session'),
      field('MODELO', model, 'next_session'),
      field('VOZ', voice, 'next_session'),
      field(
        'CHAVE DE API',
        secretField(serverMask(saved[keyName]), 'COLE A NOVA CHAVE', async (value) => {
          const body = await run(`CHAVE ${isOpenai ? 'OPENAI' : 'GEMINI'} SUBSTITUÍDA · VALOR NÃO EXIBIDO`, 'server.saveSettings', 'provider', { [keyName]: value });
          if (body) void renderCurrent();
          return Boolean(body);
        }),
        'immediate',
      ),
      h(
        'div',
        { class: 'log', style: 'min-height:0;line-height:1.7;padding-top:10px' },
        h('div', {}, 'ATIVO AGORA: ', h('span', { class: 'hi' }, `${saved.provider === 'openai' ? 'OPENAI' : 'GEMINI'} · `, h('span', { class: 'raw' }, saved.provider === 'openai' ? saved.openaiVoice : saved.geminiLiveModel))),
        note,
      ),
      h(
        'div',
        { class: 'row' },
        cmd('SALVAR', async () => {
          const body = await run(`SALVAR PROVEDOR ${draft.provider.toUpperCase()} · PRÓXIMA SESSÃO`, 'server.saveSettings', 'provider', { ...draft });
          if (body) void renderCurrent();
        }, { first: true }),
        cmd('CANCELAR', () => {
          Object.assign(draft, { provider: saved.provider, geminiLiveModel: saved.geminiLiveModel, openaiRealtimeModel: saved.openaiRealtimeModel, openaiVoice: saved.openaiVoice });
          say('ALTERAÇÕES DESCARTADAS');
          paint();
        }),
      ),
    );
  };
  paint();
  return container;
}

pages.push({
  id: 'integrations',
  nav: 'INTEGRAÇÕES',
  title: 'INTEGRAÇÕES EXTERNAS',
  async render(root) {
    const [ha, provider, calendar, status] = await Promise.all([
      window.panel.call('server.settings', 'ha'),
      window.panel.call('server.settings', 'provider'),
      window.panel.call('server.settings', 'calendar'),
      window.panel.call('server.status'),
    ]);
    setMeta('CONFIGURAÇÃO GUARDADA NO SERVIDOR');
    if (!ha.ok) return serverUnavailable(root, ha);
    const lights = status.ok ? status.body.connections : {};

    const left = h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:26px;min-width:0' },
      connectionFrame({ group: 'ha', title: 'HOME ASSISTANT', secretLabel: 'TOKEN', value: ha.body.value, light: lights.ha }),
      calendar.ok
        ? connectionFrame({
            group: 'calendar',
            title: 'AGENDA',
            secretLabel: 'CREDENCIAL',
            value: calendar.body.value,
            light: lights.calendar,
            note: 'SÓ A CONEXÃO, POR ENQUANTO: A LUNA AINDA NÃO CONSULTA A AGENDA. O TESTE SÓ CONFIRMA QUE A URL RESPONDE.',
          })
        : null,
    );
    root.append(h('div', { class: 'cols', style: 'grid-template-columns:minmax(0,1fr) minmax(0,1fr)' }, left, provider.ok ? providerFrame(provider.body.value) : h('div')));
  },
});

// ─── 05 Lembretes ────────────────────────────────────────────────────────

let confirmingReminder: number | null = null;
let reminderView: 'active' | 'history' = 'active';

/** Formulário aberto (criar ou editar). Guardado fora do render para sobreviver ao repinte. */
interface ReminderDraft {
  id: number | null;
  room_id: string;
  label: string;
  repeat: string;
  date: string;
  time: string;
  error: { field: string; text: string } | null;
  saving: boolean;
}
let reminderDraft: ReminderDraft | null = null;

const REPEAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'ÚNICO' },
  ...Object.entries(REPEAT_LABELS).map(([value, label]) => ({ value, label })),
];

const HISTORY_LABELS: Record<string, [string, string]> = {
  created: ['+ CRIADO', 'hi'],
  edited: ['✎ EDITADO', 'hi'],
  fired: ['◉ TOCOU', 'hi'],
  dismissed: ['▣ DISPENSADO', 'hi'],
  snoozed: ['‖ ADIADO', 'fg'],
  exhausted: ['◈ SEM RESPOSTA', 'amber'],
  missed: ['◈ PERDIDO', 'amber'],
  cancelled: ['— CANCELADO', 'fg'],
};
const VIA_LABELS: Record<string, string> = { admin: 'PAINEL', voice: 'VOZ' };

function localDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function openReminderDraft(r: any | null, defaultRoom: string): void {
  if (r) {
    const due = new Date(r.next_due_utc);
    reminderDraft = {
      id: r.id,
      room_id: r.room_id,
      label: r.label ?? '',
      repeat: r.repeat_rule ?? 'none',
      date: localDateInput(r.next_due_utc),
      time: r.kind === 'recurring' ? `${pad(r.local_hour)}:${pad(r.local_minute)}` : `${pad(due.getHours())}:${pad(due.getMinutes())}`,
      error: null,
      saving: false,
    };
  } else {
    reminderDraft = { id: null, room_id: defaultRoom, label: '', repeat: 'none', date: localDateInput(Date.now() + 86_400_000), time: '07:00', error: null, saving: false };
  }
  confirmingReminder = null;
}

function closeReminderDraft(): void {
  reminderDraft = null;
  pendingEscape = null;
}

function reminderEditor(draft: ReminderDraft, rooms: string[]): HTMLElement {
  const bad = (field: string): string => (draft.error?.field === field ? ' invalid' : '');
  const roomOptions = [...new Set([...rooms, draft.room_id].filter(Boolean))].sort().map((r) => ({ value: r, label: r }));
  const roomCycler = cycler(roomOptions, roomOptions.findIndex((o) => o.value === draft.room_id), (value) => {
    draft.room_id = value;
  }, 'sala');
  const repeatCycler = cycler(REPEAT_OPTIONS, REPEAT_OPTIONS.findIndex((o) => o.value === draft.repeat), (value) => {
    draft.repeat = value;
    // Data só vale para o único: repinta para mostrar ou esconder o campo.
    void renderCurrent();
  }, 'repetição');

  const labelInput = lineInput(draft.label, { maxLength: 200, placeholder: 'VAZIO = ALARME SÓ COM BIPE', 'aria-label': 'Rótulo', class: `line-input${bad('label')}` });
  labelInput.addEventListener('input', () => (draft.label = labelInput.value));
  const dateInput = lineInput(draft.date, { type: 'date', 'aria-label': 'Data', class: `line-input${bad('date')}` });
  dateInput.addEventListener('input', () => (draft.date = dateInput.value));
  const timeInput = lineInput(draft.time, { type: 'time', 'aria-label': 'Hora', class: `line-input${bad('time')}` });
  timeInput.addEventListener('input', () => (draft.time = timeInput.value));

  const save = async (): Promise<void> => {
    if (draft.saving) return;
    draft.saving = true;
    const body: Record<string, unknown> = { room_id: draft.room_id, label: draft.label.trim() || null, repeat: draft.repeat, time: draft.time };
    if (draft.repeat === 'none') body.date = draft.date;
    const title = (draft.label.trim() || 'ALARME').toUpperCase();
    const result = draft.id === null ? await window.panel.call('server.createReminder', body) : await window.panel.call('server.editReminder', draft.id, body);
    draft.saving = false;
    if (!result.ok) {
      draft.error = { field: String(result.body?.field ?? ''), text: errorOf(result) };
      say(`${draft.id === null ? 'CRIAR' : 'EDITAR'} "${title}" ... FALHA: ${errorOf(result)}`, 'warn');
      pendingEscape = null;
      void renderCurrent();
      return;
    }
    say(`${draft.id === null ? 'CRIAR' : 'EDITAR'} "${title}" (${result.body.short_id}) ... OK`);
    closeReminderDraft();
    void renderCurrent();
  };
  for (const input of [labelInput, dateInput, timeInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key === 'Escape') {
        closeReminderDraft();
        void renderCurrent();
      }
    });
  }
  pendingEscape = () => {
    closeReminderDraft();
    void renderCurrent();
  };

  const fields = grid(
    '110px minmax(0,1fr)',
    { class: 'grid', style: 'gap:10px 12px;align-items:center' },
    h('span', {}, 'SALA'),
    roomCycler,
    h('span', {}, 'RÓTULO'),
    labelInput,
    h('span', {}, 'REPETIÇÃO'),
    repeatCycler,
    draft.repeat === 'none' ? h('span', {}, 'DATA') : null,
    draft.repeat === 'none' ? dateInput : null,
    h('span', {}, 'HORA'),
    timeInput,
  );
  return frame(
    draft.id === null ? 'NOVO LEMBRETE' : 'EDITAR LEMBRETE',
    { tone: draft.error ? 'warn' : undefined, style: 'gap:12px;margin-bottom:18px' },
    fields,
    draft.error ? h('div', { class: 'amber', role: 'alert' }, `◈ ${draft.error.text.toUpperCase()}`) : null,
    h('div', { class: 'small' }, 'HORÁRIO DE BRASÍLIA · A FALA É GRAVADA PELA VOZ DA SALA QUANDO HOUVER SESSÃO ABERTA; SEM ELA, TOCA SÓ O BIPE'),
    h(
      'div',
      { class: 'row', style: 'gap:10px' },
      cmd('SALVAR', () => void save(), { first: true }),
      cmd('CANCELAR', () => {
        closeReminderDraft();
        void renderCurrent();
      }, { tone: 'quiet' }),
    ),
  );
}

pages.push({
  id: 'reminders',
  nav: 'LEMBRETES',
  title: 'LEMBRETES E ALARMES',
  pollMs: 15000,
  leave() {
    reminderDraft = null;
  },
  async render(root) {
    const [result, satsRes] = await Promise.all([window.panel.call('server.reminders'), window.panel.call('server.satellites')]);
    if (!result.ok) return serverUnavailable(root, result);
    const reminders = result.body.reminders as any[];
    const rooms = [...new Set(((satsRes.ok ? satsRes.body.satellites : []) as any[]).map((s) => s.room_id).filter(Boolean))] as string[];
    setMeta(`${reminders.length} ATIVOS`);

    const tabs = h(
      'div',
      { class: 'row', style: 'gap:6px;margin-bottom:14px' },
      cmd(reminderView === 'active' ? '► ATIVOS' : 'ATIVOS', () => {
        reminderView = 'active';
        void renderCurrent();
      }, { first: true, tone: reminderView === 'active' ? undefined : 'quiet' }),
      cmd(reminderView === 'history' ? '► HISTÓRICO' : 'HISTÓRICO', () => {
        reminderView = 'history';
        closeReminderDraft();
        void renderCurrent();
      }, { tone: reminderView === 'history' ? undefined : 'quiet' }),
      h('span', { class: 'spacer' }),
      reminderView === 'active' && !reminderDraft
        ? cmd('+ NOVO', () => {
            openReminderDraft(null, local?.roomId ?? rooms[0] ?? '');
            void renderCurrent();
          })
        : null,
    );
    root.append(tabs);

    if (reminderView === 'history') return renderReminderHistory(root);

    if (reminderDraft) root.append(reminderEditor(reminderDraft, rooms));

    if (reminders.length === 0) {
      if (!reminderDraft) root.append(emptyReport('RELATÓRIO DE AGENDAMENTO // 0 REGISTROS', 'NENHUM EVENTO AGENDADO. A TRIPULAÇÃO ESTÁ LIVRE.', 'DIGA “HEY LUNA, ME LEMBRA DE…” EM QUALQUER SALA, OU USE [ + NOVO ].'));
      return;
    }

    const cols = '150px 104px 100px 118px minmax(0,1fr) 190px';
    const rows = reminders.map((r) => {
      const label = r.label ?? 'ALARME';
      const confirming = confirmingReminder === r.id;
      const editing = reminderDraft?.id === r.id;
      const wrap = h('div', { style: `border-bottom:1px dotted var(--dim);border-left:1px solid ${confirming ? 'var(--amber)' : editing ? 'var(--hi)' : 'transparent'};border-right:1px solid ${confirming ? 'var(--amber)' : editing ? 'var(--hi)' : 'transparent'}` });
      wrap.append(
        grid(
          cols,
          { class: 'tbl-row', style: 'padding:9px 8px;font-size:12px' },
          h('span', { class: 'hi' }, label, r.status === 'ringing' ? h('span', { class: 'amber' }, ' ◉ TOCANDO') : null),
          h('span', { class: 'ellipsis' }, r.room_id),
          h('span', { class: 'hi' }, formatStamp(r.next_due_utc)),
          h('span', {}, r.repeat_rule ? REPEAT_LABELS[r.repeat_rule] ?? r.repeat_rule : 'ÚNICO'),
          h('span', { style: 'text-wrap:pretty' }, r.spoken ? `“${r.spoken}”` : '—', r.has_audio === false ? h('span', { class: 'small', style: 'display:block' }, '♪ FALA AINDA NÃO GRAVADA — TOCA SÓ O BIPE') : null),
          h(
            'span',
            { style: 'justify-self:end;display:flex;gap:4px' },
            cmd('EDITAR', () => {
              openReminderDraft(r, r.room_id);
              void renderCurrent();
            }, { disabled: r.status === 'ringing' || editing, tone: 'quiet' }),
            cmd('CANCELAR', () => {
              confirmingReminder = r.id;
              closeReminderDraft();
              void renderCurrent();
            }),
          ),
        ),
      );
      if (confirming) {
        const line = confirmLine(
          `CONFIRMAR CANCELAMENTO DE “${label.toUpperCase()}”? (S/N)`,
          { yes: '[ S ]', no: '[ N ]' },
          async () => {
            confirmingReminder = null;
            await run(`CANCELAR "${label.toUpperCase()}" (${r.short_id})`, 'server.cancelReminder', r.id);
            void renderCurrent();
          },
          () => {
            confirmingReminder = null;
            void renderCurrent();
          },
        );
        line.style.padding = '6px 8px 9px';
        wrap.append(line);
      }
      return wrap;
    });

    root.append(
      h(
        'div',
        { class: 'tbl', style: 'gap:0' },
        grid(cols, { class: 'tbl-head strong', style: 'gap:0 12px' }, h('span', {}, 'RÓTULO'), h('span', {}, 'SALA'), h('span', {}, 'PRÓXIMO'), h('span', {}, 'RECORRÊNCIA'), h('span', {}, 'A FRASE QUE A LUNA VAI FALAR'), h('span')),
        ...rows,
        h('div', { class: 'small', style: 'margin-top:10px' }, `${reminders.length} EVENTOS ATIVOS · ORDENADOS PELO PRÓXIMO DISPARO`),
      ),
    );
  },
});

async function renderReminderHistory(root: HTMLElement): Promise<void> {
  const result = await window.panel.call('server.reminderHistory', 100);
  if (!result.ok) return serverUnavailable(root, result);
  const events = result.body.events as any[];
  setMeta(`${events.length} EVENTOS RECENTES`);
  if (events.length === 0) {
    root.append(emptyReport('HISTÓRICO // 0 REGISTROS', 'NADA TOCOU AINDA.', 'O HISTÓRICO COMEÇA A CONTAR A PARTIR DESTA VERSÃO DO NÚCLEO.'));
    return;
  }
  const cols = '110px 150px minmax(0,1fr) 120px 70px';
  root.append(
    h(
      'div',
      { class: 'tbl', style: 'gap:0' },
      grid(cols, { class: 'tbl-head strong' }, h('span', {}, 'QUANDO'), h('span', {}, 'EVENTO'), h('span', {}, 'RÓTULO'), h('span', {}, 'SALA'), h('span', {}, 'VIA')),
      ...events.map((e) => {
        const [text, cls] = HISTORY_LABELS[e.kind] ?? [String(e.kind).toUpperCase(), 'fg'];
        return grid(
          cols,
          { class: 'tbl-row dotted', style: 'padding:6px 0;font-size:12px' },
          h('span', {}, formatStamp(e.at)),
          h('span', { class: cls }, text),
          h('span', { class: 'hi ellipsis' }, e.label ?? (e.short_id ? 'ALARME' : '— REMOVIDO —'), e.short_id ? h('span', { class: 'raw fg' }, `  ${e.short_id}`) : null),
          h('span', { class: 'ellipsis' }, e.room_id ?? '—'),
          h('span', {}, e.via ? VIA_LABELS[e.via] ?? e.via.toUpperCase() : '—'),
        );
      }),
      h('div', { class: 'small', style: 'margin-top:10px' }, 'SEM TRANSCRIÇÃO: SÓ O QUE ACONTECEU COM CADA LEMBRETE. RETENÇÃO DE 30 DIAS.'),
    ),
  );
}

// ─── 06 Este terminal ────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = { panel: 'LOCAL', env: '.ENV', none: 'NÃO DEFINIDO' };

/** Medidor e gráfico de score: atualizados pelos eventos ao vivo, não pelo render. */
const meter = {
  bar: null as HTMLElement | null,
  db: null as HTMLElement | null,
  score: null as HTMLElement | null,
  line: null as SVGPolylineElement | null,
  threshold: null as SVGLineElement | null,
  thresholdLabel: null as HTMLElement | null,
  status: null as HTMLElement | null,
  history: [] as Array<{ at: number; score: number }>,
  thresholdValue: null as number | null,
  wakeAt: 0,
};
const METER_CELLS = 34;
const CHART_WINDOW_MS = 8000;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function scoreChart(): HTMLElement {
  const root = svg('svg', { viewBox: '0 0 400 110', preserveAspectRatio: 'none' });
  for (const g of [0.25, 0.5, 0.75]) {
    root.append(svg('line', { x1: 0, x2: 400, y1: 105 - g * 100, y2: 105 - g * 100, stroke: '#0E5A26', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  }
  meter.threshold = svg('line', { x1: 0, x2: 400, y1: 25, y2: 25, stroke: '#39FF6A', 'stroke-width': 1, 'stroke-dasharray': '6 5', 'vector-effect': 'non-scaling-stroke' });
  meter.line = svg('polyline', { points: '', fill: 'none', stroke: '#39FF6A', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' });
  meter.line.style.filter = 'drop-shadow(0 0 3px rgba(57,255,106,.7))';
  root.append(meter.threshold, meter.line);
  return h('div', { class: 'chart' }, root as unknown as Node);
}

function paintMeter(): void {
  if (!meter.bar?.isConnected) return;
  const filled = Math.round(Math.min(1, Math.sqrt(micLevel) * 1.6) * METER_CELLS);
  meter.bar.textContent = '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled);
  meter.bar.className = `meter ${local?.muted ? 'dim' : 'hi'}`;
  const db = micLevel > 0 ? Math.max(-60, Math.round(20 * Math.log10(micLevel))) : null;
  meter.db!.textContent = db === null ? '— DB' : `${String(db).padStart(3)} DB`;

  const now = Date.now();
  meter.history = meter.history.filter((p) => now - p.at <= CHART_WINDOW_MS);
  const last = meter.history[meter.history.length - 1];
  meter.score!.textContent = (last?.score ?? 0).toFixed(2);
  meter.line!.setAttribute('points', meter.history.map((p) => `${(400 - ((now - p.at) / CHART_WINDOW_MS) * 400).toFixed(1)},${(105 - p.score * 100).toFixed(1)}`).join(' '));
  if (meter.thresholdValue !== null) {
    const y = 105 - meter.thresholdValue * 100;
    meter.threshold!.setAttribute('y1', String(y));
    meter.threshold!.setAttribute('y2', String(y));
    meter.thresholdLabel!.textContent = `${meter.thresholdValue.toFixed(2)} LIMIAR`;
    meter.thresholdLabel!.style.top = `${(y / 110) * 110 - 6}px`;
  }

  const detected = now - meter.wakeAt < 2500;
  const wantDetected = detected ? 'detected' : 'hint';
  if (meter.status!.dataset.mode !== wantDetected) {
    meter.status!.dataset.mode = wantDetected;
    meter.status!.replaceChildren(
      detected
        ? h('span', { class: 'detected' }, '▣ WAKE WORD DETECTADA')
        : h('span', { style: 'font-size:12px' }, local?.muted ? 'MICROFONE MUDO — O MEDIDOR FICA PARADO.' : 'DIGA “HEY LUNA” PERTO DO MICROFONE. O ÁUDIO NÃO SAI DESTE COMPUTADOR.'),
    );
  }
}

pages.push({
  id: 'local',
  nav: 'ESTE TERMINAL',
  title: 'ESTE TERMINAL // SATÉLITE LOCAL',
  async render(root) {
    const [viewRes, devicesRes] = await Promise.all([window.panel.call('local.get'), window.panel.call('local.audioDevices')]);
    const view = viewRes.body;
    local = view;
    paintLocal();
    const devices = (devicesRes.ok ? devicesRes.body : []) as Array<{ deviceId: string; kind: string; label: string }>;
    setMeta(`SATÉLITE ${view.deviceId}`, true);

    if (view.configError) {
      root.append(h('div', { class: 'alert', style: 'margin-bottom:18px' }, h('span', { class: 'alert-title' }, '▲ SATÉLITE LOCAL PARADO'), h('span', { style: 'font-size:12px' }, view.configError)));
    }

    // Conexão
    const serverUrl = lineInput(view.serverUrl, { name: 'serverUrl', 'aria-label': 'URL do servidor', placeholder: 'WS://192.168.0.20:8080' });
    const roomId = lineInput(view.roomId, { name: 'roomId', 'aria-label': 'Sala (room_id)', placeholder: 'escritorio' });
    const markInvalid = (result: PanelResult): void => {
      for (const input of [serverUrl, roomId]) input.classList.toggle('invalid', result.body?.field === input.name);
    };
    const localSecret = (key: 'authSecret' | 'adminToken', label: string): HTMLElement =>
      secretField(view[key].set ? `•••••••• · ${SOURCE_LABELS[view[key].source] ?? ''}` : '— NÃO DEFINIDO', 'COLE O NOVO VALOR', async (value) => {
        const result = await window.panel.call('local.save', { [key]: value });
        if (!result.ok) {
          say(`${label} ... FALHA: ${errorOf(result)}`, 'warn');
          return false;
        }
        say(`${label} SUBSTITUÍDO ... OK · VALOR NÃO EXIBIDO`);
        void renderCurrent();
        if (key === 'adminToken') void pollStatus();
        return true;
      });
    const connection = frame(
      'CONEXÃO',
      { style: 'gap:10px' },
      field('SERVIDOR', serverUrl, 'IMEDIATO (RECONECTA)', 104, true),
      field('SEGREDO', localSecret('authSecret', 'SEGREDO'), 'IMEDIATO (RECONECTA)', 104, true),
      field('SALA', roomId, 'IMEDIATO (RECONECTA)', 104, true),
      field('TOKEN ADMIN', localSecret('adminToken', 'TOKEN ADMIN'), 'immediate', 104, true),
      h(
        'div',
        { class: 'row' },
        cmd('SALVAR E RECONECTAR', async () => {
          const result = await window.panel.call('local.save', { serverUrl: serverUrl.value.trim(), roomId: roomId.value.trim() });
          markInvalid(result);
          if (!result.ok) return say(`SALVAR CONEXÃO ... FALHA: ${errorOf(result)}`, 'warn');
          say('SALVAR CONEXÃO ... OK · RECONECTANDO SE ALGO MUDOU');
          void pollStatus();
          void renderCurrent();
        }, { first: true }),
      ),
    );

    // Chaves
    const toggle = (label: string, desc: string, on: boolean, flip: () => Promise<void>): HTMLElement => {
      const b = h('button', { type: 'button', class: 'cmd first toggle', role: 'checkbox', 'aria-checked': String(on), onclick: () => void flip() }, h('span', {}, on ? '[X]' : '[ ]'), h('span', {}, label), h('span'), h('span', { class: 'desc' }, desc));
      return b;
    };
    const keys = frame(
      'CHAVES',
      { style: 'gap:6px' },
      toggle('MUDO', 'O MICROFONE DESTE TERMINAL FICA FECHADO', view.muted, async () => {
        if (await run(`MUDO ${view.muted ? 'DESLIGADO' : 'LIGADO'}`, 'local.setMuted', !view.muted)) void renderCurrent();
      }),
      toggle('INICIAR COM O WINDOWS', 'SOBE JUNTO COM A SESSÃO DO USUÁRIO', view.autostart, async () => {
        if (await run(`INICIAR COM O WINDOWS ${view.autostart ? 'DESLIGADO' : 'LIGADO'}`, 'local.setAutostart', !view.autostart)) void renderCurrent();
      }),
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        cmd('FORÇAR ESCUTA AGORA', () => void run('FORÇAR ESCUTA · PODE FALAR', 'local.forceListen'), { first: true, disabled: view.muted }),
        cmd('ABRIR PASTA DE DADOS', () => void run('ABRIR PASTA DE DADOS', 'local.openDataDir')),
      ),
    );

    // Áudio
    const deviceCycler = (kind: string, current: string, key: 'micDeviceId' | 'speakerDeviceId', name: string): HTMLElement => {
      const options = [{ value: '', label: 'PADRÃO DO SISTEMA' }, ...devices.filter((d) => d.kind === kind).map((d) => ({ value: d.deviceId, label: (d.label || 'DISPOSITIVO SEM NOME').toUpperCase() }))];
      let timer: ReturnType<typeof setTimeout> | null = null;
      return cycler(options, options.findIndex((o) => o.value === current), (value, i) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void run(`${name} → ${options[i]!.label}`, 'local.save', { [key]: value }), 500);
      }, name.toLowerCase());
    };
    meter.bar = h('span', { class: 'meter' });
    meter.db = h('span', { style: 'text-align:right' });
    meter.score = h('span', { class: 'hi' }, '0.00');
    meter.status = h('div', { style: 'min-height:28px;display:flex;align-items:center' });
    meter.thresholdLabel = h('span', { class: 'hi', style: 'top:19px' }, 'LIMIAR');
    const audio = frame(
      'ÁUDIO',
      { style: 'gap:12px' },
      grid('106px minmax(0,1fr)', { class: 'grid' }, h('span', {}, 'MICROFONE'), deviceCycler('audioinput', view.micDeviceId, 'micDeviceId', 'MICROFONE'), h('span', {}, 'ALTO-FALANTE'), deviceCycler('audiooutput', view.speakerDeviceId, 'speakerDeviceId', 'ALTO-FALANTE')),
      devicesRes.ok ? null : h('div', { class: 'amber small' }, '◈ NÃO CONSEGUI LISTAR OS DISPOSITIVOS — A CAPTURA AINDA NÃO ESTÁ PRONTA.'),
      h('div', { class: 'log row', style: 'min-height:0;padding-top:10px;flex-direction:row' }, h('span', { class: 'hi' }, 'TESTE DE MICROFONE'), h('span', { class: 'spacer' }), h('span', {}, view.muted ? '— PARADO' : '◉ AO VIVO')),
      grid('52px minmax(0,1fr) 64px', { class: 'grid' }, h('span', { class: 'small' }, 'NÍVEL'), meter.bar, meter.db),
      h(
        'div',
        { style: 'display:flex;flex-direction:column;gap:4px' },
        h('div', { class: 'row small', style: 'gap:6px' }, h('span', {}, 'SCORE DA WAKE WORD “HEY LUNA”'), h('span', { class: 'spacer' }), h('span', {}, 'ATUAL '), meter.score),
        grid('minmax(0,1fr) 78px', { class: 'grid', style: 'align-items:stretch' }, scoreChart(), h('div', { class: 'chart-axis' }, h('span', { style: 'top:-4px' }, '1.00'), meter.thresholdLabel, h('span', { style: 'bottom:-4px' }, '0.00'))),
        h('div', { class: 'row tiny' }, h('span', {}, '−8S'), h('span', { class: 'spacer' }), h('span', {}, 'AGORA')),
      ),
      meter.status,
    );
    paintMeter();

    root.append(
      h(
        'div',
        { class: 'cols', style: 'grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr)' },
        h('div', { style: 'display:flex;flex-direction:column;gap:26px;min-width:0' }, connection, keys),
        audio,
      ),
    );
  },
});

// ─── 07 Servidor ─────────────────────────────────────────────────────────

const RESTART_ESTIMATE_MS = 12000;
const RESTART_GIVE_UP_MS = 60000;

const restart = {
  phase: 'idle' as 'idle' | 'confirm' | 'count' | 'back' | 'lost',
  at: 0,
  log: [] as string[],
  took: 0,
};
let restartBox: HTMLElement | null = null;

/** `force` para a primeira pintura, com a página ainda fora do DOM. */
function paintRestart(force = false): void {
  if (!restartBox || (!force && !restartBox.isConnected)) return;
  const box = restartBox;
  const title = box.firstChild!;
  const intro = h('div', { style: 'font-size:12px;line-height:1.7;max-width:720px' }, 'REINICIAR O NÚCLEO ENCERRA TODAS AS SESSÕES DE VOZ EM ANDAMENTO E QUALQUER ALARME TOCANDO. OS SATÉLITES RECONECTAM SOZINHOS. LEMBRETES AGENDADOS SÃO PRESERVADOS NO BANCO.');
  switch (restart.phase) {
    case 'idle':
      box.replaceChildren(title, intro, cmd('REINICIAR NÚCLEO', () => {
        restart.phase = 'confirm';
        paintRestart();
      }, { tone: 'amber', first: true }));
      break;
    case 'confirm':
      box.replaceChildren(
        title,
        intro,
        confirmLine('CONFIRMAR REINÍCIO DO NÚCLEO? (S/N)', { yes: '[ S ] REINICIAR', no: '[ N ] ABORTAR' }, () => void doRestart(), () => {
          restart.phase = 'idle';
          say('REINICIAR NÚCLEO ... ABORTADO PELO OPERADOR', 'warn');
          paintRestart();
        }, true),
      );
      break;
    case 'count': {
      const elapsed = Date.now() - restart.at;
      const left = Math.max(0, Math.ceil((RESTART_ESTIMATE_MS - elapsed) / 1000));
      const fill = Math.round(Math.min(0.96, elapsed / RESTART_ESTIMATE_MS) * 48);
      box.replaceChildren(
        title,
        h('span', { class: 'display amber', style: 'font-size:28px;letter-spacing:.04em' }, left > 0 ? `NÚCLEO REINICIANDO… RETORNO ESTIMADO EM T−${pad(left)}S` : 'NÚCLEO REINICIANDO… AGUARDANDO RESPOSTA'),
        h('span', { class: 'pre' }, '█'.repeat(fill) + '░'.repeat(48 - fill)),
        ...restart.log.map((line) => h('span', { style: 'font-size:12px' }, line)),
      );
      break;
    }
    case 'back':
      box.replaceChildren(
        title,
        h('div', { class: 'row hi', style: 'gap:14px' }, h('span', { class: 'display', style: 'font-size:28px;letter-spacing:.04em' }, `▣ NÚCLEO DE VOLTA EM ${(restart.took / 1000).toFixed(1)}S.`), h('span', { class: 'spacer' }), cmd('OK', () => {
          restart.phase = 'idle';
          paintRestart();
        })),
      );
      break;
    case 'lost':
      box.replaceChildren(
        title,
        h('span', { class: 'display', style: 'font-size:28px;letter-spacing:.04em' }, `◈ NÚCLEO NÃO RESPONDEU EM ${RESTART_GIVE_UP_MS / 1000}S.`),
        h('span', { style: 'font-size:12px' }, 'VERIFIQUE O SERVIDOR (SYSTEMCTL STATUS LUNA-SERVER).'),
        cmd('OK', () => {
          restart.phase = 'idle';
          paintRestart();
        }, { tone: 'amber', first: true }),
      );
      break;
  }
}

async function doRestart(): Promise<void> {
  const body = await run('REINICIAR NÚCLEO · SINAL ENVIADO', 'server.restart');
  if (!body) {
    restart.phase = 'idle';
    paintRestart();
    return;
  }
  restart.phase = 'count';
  restart.at = Date.now();
  restart.log = ['> SINAL DE REINÍCIO ENVIADO'];
  core.link = 'restarting';
  paintCore();
  paintRestart();
  // Espera o processo cair antes de começar a perguntar — senão a primeira
  // resposta vem do núcleo velho, ainda desligando.
  await new Promise((r) => setTimeout(r, 2500));
  restart.log.push('> SESSÕES DE VOZ ENCERRADAS', '> AGUARDANDO O NÚCLEO…');
  while (restart.phase === 'count') {
    const elapsed = Date.now() - restart.at;
    if (elapsed > RESTART_GIVE_UP_MS) {
      restart.phase = 'lost';
      core.link = 'offline';
      core.offlineSince = restart.at;
      say('REINICIAR NÚCLEO ... SEM RESPOSTA', 'warn');
      break;
    }
    const result = await window.panel.call('server.status');
    if (result.ok && result.body.uptime_s * 1000 < Date.now() - restart.at + 1000) {
      restart.log.push('> RESPOSTA RECEBIDA · RESTAURANDO ENLACES');
      restart.took = Date.now() - restart.at;
      restart.phase = 'back';
      core.link = 'unknown';
      say(`REINICIAR NÚCLEO ... OK ${(restart.took / 1000).toFixed(1)}S`);
      void pollStatus();
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  paintRestart();
}

/** Bytes "hex" da chave — puro enfeite de dump de memória. */
function hexOf(key: string): string {
  return Array.from({ length: 8 }, (_, j) => (j < key.length ? key.charCodeAt(j).toString(16).toUpperCase().padStart(2, '0') : '00')).join(' ');
}

pages.push({
  id: 'server',
  nav: 'SERVIDOR',
  title: 'SERVIDOR CENTRAL',
  async render(root) {
    const result = await window.panel.call('server.bootstrap');
    if (restart.phase === 'count' || restart.phase === 'lost') {
      setMeta('NÚCLEO REINICIANDO');
    } else if (!result.ok) {
      return serverUnavailable(root, result);
    }
    const b = result.ok ? result.body : null;
    if (b) setMeta(`luna-server v${b.version}`, true);

    const rows: Array<[string, string]> = b
      ? [
          ['VERSION', `v${b.version}`],
          ['WS_PORT', String(b.ws_port)],
          ['DB_PATH', b.db_path],
          ['LOG_LEVEL', b.log_level],
          ['DEVICES_CONFIG', b.devices_config_path ?? '—'],
          ['WS_AUTH_SECRET', b.ws_auth_secret?.set ? 'definido' : 'NÃO DEFINIDO'],
          ['ADMIN_TOKEN', b.admin_token?.set ? 'definido' : 'NÃO DEFINIDO'],
        ]
      : [];
    const cols = '70px 250px 150px minmax(0,1fr)';
    const dump = frame(
      'BOOTSTRAP // SOMENTE LEITURA',
      { style: 'gap:5px' },
      grid(cols, { class: 'tbl-head' }, h('span', {}, 'ENDEREÇO'), h('span', {}, 'BYTES'), h('span', {}, 'CHAVE'), h('span', {}, 'VALOR')),
      ...rows.map(([key, value], i) =>
        grid(
          cols,
          { class: 'tbl-row', style: 'letter-spacing:.04em' },
          h('span', {}, `0x${(i * 16).toString(16).toUpperCase().padStart(4, '0')}`),
          h('span', { class: 'dim nowrap' }, hexOf(key)),
          h('span', {}, key),
          h('span', { class: 'hi raw ellipsis' }, value),
        ),
      ),
      h('div', { class: 'small', style: 'margin-top:8px' }, `FIM DO DUMP · ${rows.length} REGISTROS · ALTERAR EXIGE EDITAR O .ENV DO SERVIDOR E REINICIAR`),
    );

    restartBox = frame('ZONA DE PERIGO', { tone: 'danger', style: 'gap:12px' });
    root.append(h('div', { class: 'stack', style: 'gap:28px' }, dump, restartBox));
    paintRestart(true);
  },
});

// ─── 08 Diagnóstico ──────────────────────────────────────────────────────

const DIAG_WINDOWS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1H' },
  { value: 24, label: '24H' },
  { value: 168, label: '7D' },
  { value: 720, label: '30D' },
];
const LOG_LEVELS: Array<{ value: string; label: string }> = [
  { value: 'debug', label: 'DEBUG+' },
  { value: 'info', label: 'INFO+' },
  { value: 'warn', label: 'WARN+' },
  { value: 'error', label: 'ERROR+' },
];
const LOG_MAX_LINES = 300;
const TTFAB_BAR = 40;

const diag = {
  hours: 24,
  level: 'info',
  room: null as string | null,
  paused: false,
  lines: [] as any[],
  box: null as HTMLElement | null,
  status: null as HTMLElement | null,
  streamState: 'closed' as 'connecting' | 'open' | 'closed',
  streamError: null as string | null,
};

const LEVEL_TAGS: Record<string, string> = { trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };

function msOrDash(ms: number | null | undefined): string {
  return typeof ms === 'number' ? `${String(ms).padStart(4)}MS` : '----MS';
}

/** `12:04:33` */
function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Barra de texto: █ até o p50, ▒ até o p90, ┊ na meta. Escala comum a todas as linhas. */
function ttfabBar(p50: number | null, p90: number | null, target: number, scaleMs: number): string {
  const col = (ms: number): number => Math.min(TTFAB_BAR - 1, Math.round((ms / scaleMs) * TTFAB_BAR));
  const targetCol = col(target);
  let s = '';
  for (let i = 0; i < TTFAB_BAR; i++) {
    if (p50 !== null && i < col(p50)) s += '█';
    else if (p90 !== null && i < col(p90)) s += '▒';
    else if (i === targetCol) s += '┊';
    else s += '·';
  }
  return s;
}

function latencyChart(samples: any[], target: number, since: number, until: number): HTMLElement {
  const W = 800;
  const H = 140;
  const warm = samples.filter((s) => !s.session_cold).map((s) => s.latency_ms as number);
  const top = Math.max(target * 2, ...warm.map((v) => Math.min(v, target * 5)));
  const y = (ms: number): number => H - 5 - (Math.min(ms, top) / top) * (H - 10);
  const x = (at: number): number => ((at - since) / Math.max(1, until - since)) * W;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `TTFAB de ${samples.length} turnos, meta ${target} ms` });
  root.append(svg('line', { x1: 0, x2: W, y1: y(target), y2: y(target), stroke: '#39FF6A', 'stroke-width': 1, 'stroke-dasharray': '6 5', 'vector-effect': 'non-scaling-stroke' }));
  for (const s of samples) {
    const over = s.latency_ms > target;
    root.append(
      svg('rect', {
        x: x(s.at) - 1.5,
        y: y(s.latency_ms) - 1.5,
        width: 3,
        height: 3,
        fill: s.session_cold ? '#0E5A26' : over ? '#FFB000' : '#39FF6A',
      }),
    );
  }
  return h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:4px' },
    grid(
      'minmax(0,1fr) 78px',
      { class: 'grid', style: 'align-items:stretch' },
      h('div', { class: 'chart' }, root as unknown as Node),
      h(
        'div',
        { class: 'chart-axis' },
        h('span', { style: 'top:-4px' }, `${top}MS`),
        h('span', { style: `top:${(y(target) / H) * 140 - 6}px` }, `${target}MS META`),
        h('span', { style: 'bottom:-4px' }, '0MS'),
      ),
    ),
    h('div', { class: 'row tiny' }, h('span', {}, formatStamp(since)), h('span', { class: 'spacer' }), h('span', {}, 'AGORA')),
  );
}

function logLine(r: any): HTMLElement {
  const tone = r.level === 'error' || r.level === 'fatal' || r.level === 'warn' ? 'amber' : r.level === 'debug' || r.level === 'trace' ? 'fg' : '';
  return grid(
    '64px 34px 190px 110px minmax(0,1fr)',
    { class: `tbl-row log-line ${tone}` },
    h('span', {}, formatClock(r.ts)),
    h('span', {}, LEVEL_TAGS[r.level] ?? r.level),
    h('span', { class: 'raw ellipsis' }, r.event ?? '—'),
    h('span', { class: 'ellipsis' }, r.room_id ?? '—'),
    h('span', { class: 'raw ellipsis', title: r.msg }, r.msg || '—'),
  );
}

function paintLogStatus(): void {
  if (!diag.status?.isConnected) return;
  const text =
    diag.paused
      ? '‖ PAUSADO'
      : diag.streamState === 'open'
        ? '◉ AO VIVO'
        : diag.streamState === 'connecting'
          ? `░ CONECTANDO${diag.streamError ? ` · ${diag.streamError.toUpperCase()}` : ''}`
          : `— PARADO${diag.streamError ? ` · ${diag.streamError.toUpperCase()}` : ''}`;
  diag.status.textContent = text;
  diag.status.className = diag.streamError && diag.streamState !== 'open' ? 'amber' : diag.streamState === 'open' && !diag.paused ? 'hi' : '';
}

function appendLogLine(record: any): void {
  diag.lines.push(record);
  if (diag.lines.length > LOG_MAX_LINES) diag.lines.shift();
  const box = diag.box;
  if (!box?.isConnected || diag.paused) return;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.append(logLine(record));
  while (box.childElementCount > LOG_MAX_LINES) box.firstElementChild!.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function restartLogStream(): void {
  diag.lines = [];
  diag.box?.replaceChildren();
  void window.panel.call('logs.start', diag.level, diag.room);
}

pages.push({
  id: 'diagnostics',
  nav: 'DIAGNÓSTICO',
  title: 'DIAGNÓSTICO // LATÊNCIA E LOG',
  pollMs: 30000,
  leave() {
    void window.panel.call('logs.stop');
    diag.streamState = 'closed';
  },
  async render(root) {
    const [latRes, errRes, satsRes] = await Promise.all([
      window.panel.call('server.latency', diag.hours),
      window.panel.call('server.errors', 20),
      window.panel.call('server.satellites'),
    ]);
    if (!latRes.ok) return serverUnavailable(root, latRes);
    const lat = latRes.body;
    const summary = lat.summary as any[];
    const samples = lat.samples as any[];
    const target: number = lat.target_ms;
    setMeta(`${lat.total ?? samples.length} TURNOS EM ${DIAG_WINDOWS.find((w) => w.value === diag.hours)?.label ?? `${diag.hours}H`} · META ${target}MS`);

    const windowCycler = cycler(DIAG_WINDOWS, DIAG_WINDOWS.findIndex((w) => w.value === diag.hours), (value) => {
      diag.hours = value;
      void renderCurrent();
    }, 'janela');

    const scale = Math.max(target * 2, ...summary.map((g) => g.p90_ms ?? 0));
    const cols = '150px 90px minmax(0,1fr) 76px 76px 56px 64px';
    const ttfab = frame(
      `TTFAB POR SALA // META ${target}MS`,
      { style: 'gap:4px' },
      h('div', { class: 'row', style: 'gap:12px;padding-bottom:6px' }, h('span', { class: 'small' }, 'JANELA'), windowCycler, h('span', { class: 'spacer' }), h('span', { class: 'small' }, '█ P50 · ▒ P90 · ┊ META')),
      grid(cols, { class: 'tbl-head' }, h('span', {}, 'SALA'), h('span', {}, 'PROVEDOR'), h('span', {}, 'DISTRIBUIÇÃO'), h('span', {}, 'P50'), h('span', {}, 'P90'), h('span', {}, 'N'), h('span', {}, '>META')),
      ...summary.map((g) =>
        grid(
          cols,
          { class: 'tbl-row' },
          h('span', { class: 'ellipsis' }, g.room_id),
          h('span', {}, String(g.provider).toUpperCase()),
          h('span', { class: `pre ${g.p90_ms !== null && g.p90_ms > target ? 'amber' : 'hi'}`, 'aria-label': `p50 ${g.p50_ms ?? 'sem dado'} ms, p90 ${g.p90_ms ?? 'sem dado'} ms` }, ttfabBar(g.p50_ms, g.p90_ms, target, scale)),
          h('span', { class: g.p50_ms !== null && g.p50_ms > target ? 'amber' : 'hi' }, msOrDash(g.p50_ms)),
          h('span', { class: g.p90_ms !== null && g.p90_ms > target ? 'amber' : 'hi' }, msOrDash(g.p90_ms)),
          h('span', {}, String(g.count)),
          h('span', { class: g.over_target ? 'amber' : '' }, String(g.over_target)),
        ),
      ),
      summary.length === 0 ? h('div', { style: 'padding:10px 0 4px' }, 'NENHUM TURNO MEDIDO NESTA JANELA. FALE COM A LUNA E VOLTE AQUI.') : null,
      summary.some((g) => g.cold) ? h('div', { class: 'small', style: 'padding-top:6px' }, `SESSÕES FRIAS FORA DOS PERCENTIS: ${summary.reduce((n, g) => n + g.cold, 0)} (CUSTO DE CONEXÃO, NÃO DE TURNO)`) : null,
    );

    const series = frame(
      'SÉRIE // LIMITE INFERIOR',
      { style: 'gap:6px' },
      samples.length ? latencyChart(samples, target, lat.since, Date.now()) : h('div', {}, 'SEM AMOSTRAS.'),
      h('div', { class: 'small' }, '▪ VERDE: DENTRO DA META · ▪ ÂMBAR: ACIMA · ▪ APAGADO: SESSÃO FRIA'),
      lat.truncated ? h('div', { class: 'small' }, `SÉRIE: OS ${samples.length} TURNOS MAIS RECENTES DE ${lat.total}. OS PERCENTIS USAM TODOS.`) : null,
    );

    const errors = (errRes.ok ? errRes.body.errors : []) as any[];
    const errCols = '100px 190px 110px minmax(0,1fr)';
    const errFrame = frame(
      'ÚLTIMOS ERROS',
      { tone: errors.length ? 'warn' : undefined, style: 'gap:0' },
      grid(errCols, { class: 'tbl-head' }, h('span', {}, 'QUANDO'), h('span', {}, 'EVENTO'), h('span', {}, 'SALA'), h('span', {}, 'MENSAGEM')),
      ...errors.map((e) =>
        grid(errCols, { class: 'tbl-row dotted' }, h('span', { class: 'amber' }, formatStamp(e.at)), h('span', { class: 'raw ellipsis' }, e.event ?? '—'), h('span', { class: 'ellipsis' }, e.room_id ?? '—'), h('span', { class: 'raw ellipsis', title: e.msg }, e.msg)),
      ),
      errors.length === 0 ? h('div', { style: 'padding:10px 0 4px' }, errRes.ok ? 'NENHUM ERRO REGISTRADO. SISTEMAS NOMINAIS.' : `◈ ${errorOf(errRes)}`) : null,
    );

    // Log ao vivo: filtros no servidor; as linhas chegam como evento e
    // entram direto na caixa, sem repintar a página.
    const rooms = [...new Set(((satsRes.ok ? satsRes.body.satellites : []) as any[]).map((s) => s.room_id).filter(Boolean))].sort() as string[];
    if (diag.room && !rooms.includes(diag.room)) rooms.push(diag.room);
    const roomOptions = [{ value: null as string | null, label: 'TODAS' }, ...rooms.map((r) => ({ value: r as string | null, label: r }))];
    const roomCycler = cycler(roomOptions, roomOptions.findIndex((o) => o.value === diag.room), (value) => {
      diag.room = value;
      restartLogStream();
    }, 'sala');
    const levelCycler = cycler(LOG_LEVELS, LOG_LEVELS.findIndex((o) => o.value === diag.level), (value) => {
      diag.level = value;
      restartLogStream();
    }, 'nível');

    diag.status = h('span');
    diag.box = h('div', { class: 'log-box', role: 'log', 'aria-live': 'off' });
    diag.box.append(...diag.lines.map(logLine));
    const pauseBtn = cmd(diag.paused ? 'RETOMAR' : 'PAUSAR', () => {
      diag.paused = !diag.paused;
      pauseBtn.textContent = `[ ${diag.paused ? 'RETOMAR' : 'PAUSAR'} ]`;
      if (!diag.paused) {
        diag.box!.replaceChildren(...diag.lines.map(logLine));
        diag.box!.scrollTop = diag.box!.scrollHeight;
      }
      paintLogStatus();
    });
    const live = frame(
      'LOG AO VIVO // SEM TRANSCRIÇÃO',
      { style: 'gap:6px' },
      h(
        'div',
        { class: 'row', style: 'gap:16px;flex-wrap:wrap' },
        h('span', { class: 'small' }, 'SALA'),
        roomCycler,
        h('span', { class: 'small' }, 'NÍVEL'),
        levelCycler,
        h('span', { class: 'spacer' }),
        diag.status,
        pauseBtn,
        cmd('LIMPAR', () => {
          diag.lines = [];
          diag.box!.replaceChildren();
        }, { tone: 'quiet' }),
      ),
      diag.box,
    );

    root.append(
      h(
        'div',
        { class: 'stack', style: 'gap:22px' },
        ttfab,
        series,
        errFrame,
        live,
      ),
    );
    paintLogStatus();
    queueMicrotask(() => {
      if (diag.box) diag.box.scrollTop = diag.box.scrollHeight;
    });
    if (diag.streamState === 'closed') {
      diag.streamState = 'connecting';
      restartLogStream();
    }
  },
});

// ─── eventos ao vivo ─────────────────────────────────────────────────────

window.panel.onEvent((event) => {
  switch (event?.type) {
    case 'navigate':
      void show(String(event.tab));
      break;
    case 'local':
      local = event.view;
      paintLocal();
      break;
    case 'mic':
      micLevel = event.level;
      paintMeter();
      break;
    case 'wake-score':
      meter.history.push({ at: Date.now(), score: event.score });
      if (typeof event.threshold === 'number') meter.thresholdValue = event.threshold;
      paintMeter();
      break;
    case 'wake':
      meter.wakeAt = Date.now();
      paintMeter();
      break;
    case 'log':
      appendLogLine(event.record);
      break;
    case 'log-status':
      diag.streamState = event.state;
      diag.streamError = event.error;
      paintLogStatus();
      break;
  }
});

// ─── teclado ─────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (!$('boot').hidden) {
    hideBoot();
    e.preventDefault();
    return;
  }
  const tag = (e.target as HTMLElement | null)?.tagName ?? '';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  const key = e.key.toLowerCase();
  const confirm = liveConfirm();
  if (confirm) {
    if (key === 's') confirm.yes();
    else if (key === 'n' || key === 'escape') confirm.no();
    return;
  }
  if (key === 'escape' && pendingEscape) {
    pendingEscape();
    return;
  }
  if (/^[1-8]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey && !$('workspace').hidden) {
    const page = pages[Number(key) - 1];
    if (page) void show(page.id);
    e.preventDefault();
  }
});

// ─── boot ────────────────────────────────────────────────────────────────

let bootTimer: ReturnType<typeof setTimeout> | null = null;

function hideBoot(): void {
  if (bootTimer) clearTimeout(bootTimer);
  $('boot').hidden = true;
}

/** Sequência de inicialização com os enlaces reais. Qualquer tecla ou clique pula. */
async function bootSequence(): Promise<void> {
  const boot = $('boot');
  boot.hidden = false;
  boot.addEventListener('click', hideBoot);
  const line = (text: string, cls = ''): HTMLElement => {
    const el = h('div', { class: `boot-line ${cls}` });
    boot.append(el);
    typeInto(el, text, { cps: 160 });
    return el;
  };
  line('LUNA 6000 // SEQUÊNCIA DE INICIALIZAÇÃO', 'hi');
  const skip = h('div', { class: 'small', style: 'margin-top:auto' }, '[ QUALQUER TECLA OU CLIQUE PARA PULAR ]');

  const started = performance.now();
  const [statusRes, satsRes, localRes] = await Promise.all([window.panel.call('server.status'), window.panel.call('server.satellites'), window.panel.call('local.get')]);
  const latency = Math.round(performance.now() - started);
  const dots = (label: string): string => `${label} `.padEnd(32, '.') + ' ';
  const steps: Array<[string, string]> = [];
  steps.push([dots('SATÉLITE LOCAL') + (localRes.ok && !localRes.body.configError ? '▣ OK' : '◈ FALHA'), localRes.ok && !localRes.body.configError ? '' : 'amber']);
  if (statusRes.ok) {
    steps.push([dots('ENLACE COM O NÚCLEO') + `▣ OK ${latency}MS`, '']);
    for (const [key, label] of LINK_LABELS) {
      const light = lightText(statusRes.body.connections?.[key]?.light ?? 'unknown');
      steps.push([dots(label) + light.text, light.cls === 'amber' ? 'amber' : '']);
    }
    if (satsRes.ok) {
      const sats = satsRes.body.satellites as any[];
      steps.push([dots('SATÉLITES') + `${sats.filter((s) => s.online).length}/${sats.length} ONLINE`, '']);
    }
  } else {
    steps.push([dots('ENLACE COM O NÚCLEO') + (statusRes.body?.offline ? '◈ SEM SINAL' : '◈ SEM ACESSO'), statusRes.body?.offline ? 'red' : 'amber']);
  }

  if (boot.hidden) return;
  const stagger = reduced() ? 0 : 200;
  steps.forEach(([text, cls], i) => setTimeout(() => !boot.hidden && line(text, cls), stagger * (i + 1)));
  const readyAt = stagger * (steps.length + 1) + (reduced() ? 0 : 250);
  setTimeout(() => {
    if (boot.hidden) return;
    const ready = h('div', { class: `boot-ready${statusRes.ok ? '' : ' red'}` });
    boot.append(ready, skip);
    typeInto(ready, statusRes.ok ? 'LUNA 6000 — PRONTA' : 'LUNA 6000 — SEM NÚCLEO', { cps: 40, cursor: statusRes.ok ? 'hi' : 'red', keepCursor: true });
    bootTimer = setTimeout(hideBoot, reduced() ? 1200 : 1600);
  }, readyAt);
}

// ─── início ──────────────────────────────────────────────────────────────

function buildNav(): void {
  const nav = $('nav');
  pages.forEach((page, i) => {
    nav.append(
      h(
        'button',
        { type: 'button', class: `nav-item${page.soon ? ' soon' : ''}`, 'data-page': page.id, onclick: () => void show(page.id) },
        h('span', {}, pad(i + 1)),
        h('span', { class: 'nav-label' }, page.nav, page.soon ? h('span', { class: 'nav-tag' }, 'EM BREVE') : null),
      ),
    );
  });
}

buildNav();
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== currentPage?.id) void show(id);
});
setInterval(paintClock, 1000);
setInterval(paintWave, 80);
setInterval(() => {
  paintMeter();
  if (restart.phase === 'count') paintRestart();
}, 250);

void (async () => {
  const localRes = await window.panel.call('local.get');
  if (localRes.ok) {
    local = localRes.body;
    paintLocal();
  }
  paintClock();
  void bootSequence();
  void pollStatus();
  void show(location.hash.slice(1) || 'home');
})();
