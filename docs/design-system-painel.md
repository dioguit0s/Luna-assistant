# Design system do painel — "LUNA 6000"

**Status:** implementado no `luna-desktop` (`src/panel/`)
**Data:** 2026-09-24
**Origem:** projeto *Painel LUNA interativo* no Claude Design (`Painel LUNA.dc.html` e
`LUNA Design System.dc.html`)
**Relacionados:** [Painel de controle](painel-de-controle.md) · [ADR 010](adr/010-painel-de-controle-e-api-admin.md)

O painel de controle imita o terminal de fósforo verde de uma nave de ficção
científica: tela preta, texto monoespaçado em caixa alta, molduras de caracteres de
caixa, texto que se "digita" com cursor █ e efeitos de tubo CRT (varredura, ruído,
cintilação, vidro curvo). Este documento é a referência para mexer no painel sem
quebrar a linguagem visual. **Mudou um token em `panel.css`? Mude aqui também.**

## Onde vive

| Arquivo | O que tem |
|---|---|
| `luna-desktop/src/panel/panel.css` | Tokens (`:root`), `@font-face`, efeitos CRT e todas as classes de componente |
| `luna-desktop/src/panel/panel.ts` | Fábricas de componente (`frame`, `kv`, `cmd`, `field`, `cycler`, `secretField`, `confirmLine`, `typeInto`, `say`) e as oito telas |
| `luna-desktop/src/panel/index.html` | Esqueleto fixo: barra do topo, menu, linha de comando, faixa de voz, sobreposições |
| `luna-desktop/scripts/copy-renderer.mjs` | Copia as fontes de `@fontsource/*` para `dist/panel/fonts/` |

## Tokens de cor

Contraste medido sobre `--bg`. O brilho de fósforo é um `text-shadow` da própria cor:
`0 0 1px currentColor, 0 0 6px color-mix(in srgb, currentColor 45%, transparent)`
(token `--glow`, aplicado no `body` e herdado).

| Token | Valor | Contraste | Uso |
|---|---|---|---|
| `--bg` | `#050805` | — | Tela. A vinheta do vidro fica por cima |
| `--hi` (fósforo alto) | `#39FF6A` | 14.5:1 | Destaque, valores, cabeçalho de tabela, inversão de hover/foco |
| `--fg` (fósforo) | `#1FAF4A` | 6.9:1 | Texto corrente e molduras |
| `--dim` (fósforo apagado) | `#0E5A26` | 2.4:1 | Desabilitado, réguas, pontilhados. **Nunca texto útil** |
| `--amber` | `#FFB000` | 11.3:1 | **Só alertas**: falha de enlace, validação, destrutivo |
| `--red` | `#FF3B30` | 5.6:1 | **Só falha crítica**: núcleo sem sinal |
| `--field-focus` | `#0b170d` | — | Fundo de campo de texto em foco |

Texto sobre `--dim` ou em `--dim` perde o brilho (`text-shadow: none`) — brilho em cor
apagada vira borrão.

## Tipografia

Fontes empacotadas (a CSP do painel não permite rede): `@fontsource/vt323` e
`@fontsource/ibm-plex-mono`, subset *latin* (cobre o português). Glifos de caixa e de
bloco (`╞═╡ ▣ ◈ ░ █ ▁▂▃`) não existem nelas e caem no monoespaçado do sistema
(Consolas) — igual ao design. Licença OFL copiada junto, em `dist/panel/fonts/`.

| Papel | Fonte | Tamanho | Onde |
|---|---|---|---|
| Display | VT323 | 64 | "LUNA 6000 — PRONTA" no boot |
| Alerta | VT323 | 52 | "SEM SINAL DO NÚCLEO" |
| Título | VT323 | 25–28 | Marca no topo, título de tela, nomes grandes (`.display`) |
| Corpo | IBM Plex Mono | 13 | Texto corrente |
| Tabela | IBM Plex Mono | 12 | Linhas de tabela, log |
| Rotulagem | IBM Plex Mono | 10–11 | Cabeçalhos de tabela, `APLICA:`, metadados (`.small`, `.tiny`) |

- **Caixa alta sempre** (`text-transform: uppercase` no `body`), exceto identificadores
  técnicos — `entity_id`, `device_id`, URL, versão, caminho — que usam `.raw`.
- **Números tabulares** (`font-variant-numeric: tabular-nums`).
- **Espaçamento de letras:** `0.06em` no corpo, até `0.14em` em títulos de moldura.

## Componentes

Cada componente tem uma fábrica em `panel.ts`; use a fábrica em vez de montar o HTML
à mão.

| Componente | Fábrica / classe | Regra |
|---|---|---|
| **Moldura** | `frame(título, { tone })` → `.frame` | Borda 1px `--fg`, título `╞═ NOME ═╡` sobre a borda. `tone: 'warn'` (âmbar, enlace com falha), `'muted'` (apagada), `'danger'` (dupla 3px âmbar, título `╔═ NOME ═╗`), `'lock'` (dupla 3px `--hi`, módulo bloqueado) |
| **Botão-comando** | `cmd(rótulo, onclick, { tone })` → `.cmd` | Texto `[ AÇÃO ]`, sem borda. Hover **inverte** (fundo `--hi`, texto `--bg`); foco inverte **e** ganha moldura 1px. `tone: 'amber'` para destrutivo, `'red'` só na tela sem sinal, `'quiet'` para ação secundária. Desabilitado fica `--dim` |
| **Linha chave‥valor** | `kv(rótulo, valor)` → `.kv` | Rótulo, régua pontilhada `--dim`, valor em `--hi` |
| **Campo** | `field(rótulo, controle, quando)` → `.field` | Grade rótulo \| controle \| `APLICA: IMEDIATO` / `PRÓXIMA SESSÃO`. Com `below`, o `APLICA` desce para baixo do controle (colunas estreitas) |
| **Entrada de texto** | `lineInput()` → `.line-input` | Só sublinhado 1px; foco muda o fundo para `--field-focus`; inválido sublinha em âmbar e mostra `◈ MOTIVO` embaixo (`.field-error`) |
| **Segredo** | `secretField(máscara, …)` | Mostra só `••••••••` + os **4 últimos caracteres**. `[ SUBSTITUIR ]` abre um campo de senha; ENTER grava, ESC desiste. O valor nunca volta à tela |
| **Seletor cíclico** | `cycler(opções, …)` | `‹ VALOR ›` — substitui `<select>`. Para lista fechada (área do HA, microfone, voz) |
| **Rádio / toggle** | `(•) GEMINI  ( ) OPENAI` · `[X] MUDO` | Botões com `role="radio"` / `role="checkbox"` e `aria-checked` |
| **Chip** | `.chip` | Apelido de dispositivo, com `×` para remover; `[ + APELIDO ]` ao lado |
| **Tabela** | `.tbl`, `.tbl-head`, `.tbl-row` + `grid(colunas, …)` | Linhas em CSS grid com colunas explícitas. Linha selecionável (`.sel`) ganha moldura `--hi` e marcador `►` |
| **Semáforo** | `lightText(light)` | `▣ OK` (`--hi`) · `◈ FALHA` (âmbar) · `░ DESCONHECIDO` · `— DESLIGADO`. **O glifo e a palavra bastam sozinhos; a cor só reforça** |
| **Faixa de alerta** | `.banner` | Fundo âmbar cheio — enlace perdido na tela Início |
| **Alerta em moldura** | `.alert` | Borda âmbar — sala sem área, satélite local parado |
| **Confirmação** | `confirmLine(pergunta, …)` | Linha âmbar `PERGUNTA? (S/N)█ [ S ] [ N ]`. Teclas S/N/ESC funcionam |
| **Log de comando** | `.log` | Separador tracejado, linhas `> …` digitadas — resultado do "testar conexão" |
| **Relatório vazio** | `emptyReport()` | Moldura central com manchete VT323 digitada e dica de voz |

## Estrutura da tela

```
┌──────────────────────────────────────────────────────────────────┐
│ INTERFACE 2037 // LUNA 6000        DATA HORA  UPTIME  [STATUS]   │ barra do topo
├────────────┬─────────────────────────────────────────────────────┤
│ ┌ MENU     │ 0N // TÍTULO DA TELA (digitado)            metadado │
│ 01 INÍCIO  │                                                     │
│ …          │   molduras da tela                                  │
│ 08 DIAGN.  │                                                     │
│ └ TECLAS   │                                                     │
├────────────┴─────────────────────────────────────────────────────┤
│ > ÚLTIMO COMANDO ... OK█                  NÚCLEO host · OPERADOR │ linha de comando
├──────────────────────────────────────────────────────────────────┤
│ ◉ ESCUTANDO…  ▂▃▅▃▂▁▂▄▆▅▃▂▁▁▂▃▅▇▅▃▂▁…           SALA · device_id │ faixa de voz
└──────────────────────────────────────────────────────────────────┘
```

- **Status do topo:** `▣ NOMINAL` · `▲ ALERTA` (algum enlace com falha) · `◈ SEM ACESSO`
  (token admin ausente ou recusado) · `◈ SEM SINAL` (núcleo inacessível) ·
  `░ REINICIANDO`.
- **Linha de comando** substitui toasts: toda ação narra o resultado como
  `> AÇÃO ... OK` ou, em âmbar, `> AÇÃO ... FALHA: motivo` (função `say`).
- **Faixa de voz** mostra o estado **deste satélite** (o desktop): `— EM ESPERA`,
  `◉ ESCUTANDO…`, `◌ PROCESSANDO…`, `◉ FALANDO…`, `◈ SEM ENLACE`. Enquanto escuta, a
  amplitude segue o nível real do microfone. **Nunca mostra transcrição** — só estado,
  forma de onda e origem (decisão de produto do painel).
- **Sem sinal:** quando o núcleo não responde, a área de trabalho dá lugar a uma tela
  vermelha com tentativa, contagem e alvo. "Este terminal" continua acessível — é lá
  que se corrige a URL.
- **Boot:** ao abrir, uma sequência de inicialização checa os enlaces reais e termina
  em `LUNA 6000 — PRONTA`. Qualquer tecla ou clique pula.

## Regras

1. **Molduras:** 1px `--fg` com título `╞═ NOME ═╡` sobre a borda. Zona de perigo: dupla
   3px âmbar.
2. **Sem cantos arredondados, sem sombra suave, sem gradiente.** A única curvatura é a
   do vidro do tubo (`.fx-glass`).
3. **Texto novo é digitado** com cursor █ (`typeInto`). Com
   `prefers-reduced-motion`, aparece inteiro, o cursor não pisca e cintilação/animações
   desligam.
4. **Destrutivo sempre pede (S/N) na linha**, em âmbar — nunca `confirm()` do sistema.
5. **Segredos mostram só os 4 últimos caracteres** (quando o servidor os dá).
6. **Âmbar só para alerta, vermelho só para falha crítica.** Estado normal é verde.
7. **Teclado:** 1–8 navegam entre telas, ESC cancela edição ou confirmação, S/N
   respondem confirmações.
8. **Efeitos CRT são decorativos:** `pointer-events: none`, `aria-hidden`, nunca carregam
   informação.
9. **Nada de número inventado.** A tela Diagnóstico (v2) mostra o esqueleto apagado do que
   virá, com `----` no lugar dos valores — o design tinha dados de exemplo, a
   implementação não.

## Diferenças em relação ao design original

O design é um protótipo com dados falsos; a implementação segue a API admin real
([painel-de-controle.md](painel-de-controle.md#api-admin-v1)). Onde os dois divergem:

- **Barra de título falsa** (`─ □ ✕`) não existe: a janela usa a moldura nativa do
  Windows. Tamanho de referência 1200×760, mínimo 960×600; o layout ocupa a janela em
  vez de escalar um quadro fixo.
- **Modelo do provedor** é um campo de texto (o servidor aceita qualquer nome), não um
  seletor. **Voz** só existe para OpenAI; no Gemini aparece "DEFINIDA PELO MODELO".
- **Apelidos** apontam para o nome do dispositivo (`device`), como na API — os chips de
  uma linha são os apelidos cujo alvo é aquele dispositivo.
- **Salas da Luna** são as salas com satélite ou com mapeamento; **áreas órfãs** são as
  áreas do HA que nenhuma delas usa.
- **Teste de microfone** é sempre ao vivo (o processo principal manda nível e score
  enquanto o painel está aberto), sem botão iniciar/parar. O limiar vem do sidecar.
- **"Forçar escuta"** é uma ação (`[ FORÇAR ESCUTA AGORA ]`), não um toggle.
- **Reinício do núcleo** acompanha o `server.status` de verdade até o processo novo
  responder (desiste em 60 s), em vez de uma contagem fixa.
- **Satélites:** firmware, IP, sinal Wi-Fi e "identificar" aparecem desabilitados como
  "indisponível nesta versão" — dependem de protocolo e firmware (ver inventário).
