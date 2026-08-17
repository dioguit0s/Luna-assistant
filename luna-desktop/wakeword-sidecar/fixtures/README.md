# Fixtures do wake word

| arquivo | serve para | status |
|---|---|---|
| `../../../luna-client-test/fixtures/silence.wav` (reuso) | prova de zero falso-positivo — 2s de silêncio digital, 100% zeros | ✅ existe |
| `okay-nabu.wav` | **positivo de controle** — `okay_nabu.tflite` é o modelo comprovadamente forte (ADR 003: 0.95-1.00 no INMP441); se ele não disparar aqui, o problema é o sidecar, não o modelo | ✅ gravado e validado — **8/8 detecções** (recall 100%), `mean_prob` 0.970-0.993 |
| `hey-luna.wav` | o alvo de verdade, contra `hey_luna_trained.tflite` | ✅ gravado e validado — **3/10 detecções** (recall ~30%); quando dispara é com confiança e sem falso-positivo, mas perde a maioria das tentativas. Bate com o `test_auc: 0.536` já documentado em `hey_luna_trained.json` — ver "Implicação para o marco 4" no `README.md` deste diretório |
| `noise-smoke.wav` | falso-positivo — mesmo teste que validou o firmware | ✅ gravado (50s) e testado — **0 detecções** nos dois modelos (`okay_nabu` chegou a `max_mean_prob=0.29`; `hey_luna_trained` a `0.017`, ambos bem abaixo do cutoff 0.97). **Curto**: 50s é bem menos que os ≥15min recomendados (o mesmo padrão que validou o firmware no ADR 003) — resultado é um sinal positivo de fumaça, não uma prova robusta de ausência de falso-positivo em uso real. Uma sessão mais longa (≥15min de TV/conversa) fica como follow-up recomendado antes/durante o M4, sem bloquear o M3 |

`silence.wav` provou ausência de falso-positivo, mas não provava que a
extração de features estava correta — isso só ficou confirmado depois de
gravar voz real com `LUNA_DUMP_MIC` e rodar contra `okay_nabu.tflite`
(2026-08-17).

## Como gravar

Use o `luna-desktop` como gravador — a fixture fica com o áudio **exato** que
o marco 4 vai ouvir (pós AGC/ruído/eco do `getUserMedia`), não o de outro
microfone/app:

```powershell
cd luna-desktop
$env:LUNA_DUMP_MIC='1'; npm run dev
```

(PowerShell é o padrão no Windows — `LUNA_DUMP_MIC=1 npm run dev` sem `$env:`
é sintaxe bash e não funciona lá. `set LUNA_DUMP_MIC=1 && npm run dev` no
cmd.exe.)

Mute o mic pelo menu da bandeja antes de falar (senão a Luna responde de
verdade — o marco 4 ainda não liga o sidecar na máquina de estados, o mic
segue transmitindo ao vivo pro `luna-server`). Fale a frase repetidas vezes
com pausas de ~2-3s (o refratário do detector é curto o suficiente pra cada
repetição virar uma detecção separada), saia pelo menu (o `.wav` só fica
correto depois do `close()`), copie de `%APPDATA%\luna-desktop\mic-dump-
<timestamp>.wav` pra cá.

**Deixe ~1s de silêncio antes de falar.** Os 15 `SETTLE_WINDOWS` iniciais do
detector engolem os primeiros ~450ms de áudio (paridade com o boot do
firmware — ver README.md deste diretório) — uma frase colada no início do
arquivo não dispararia, e isso não seria um bug do sidecar.

Para ruído de fundo (TV/conversa): mesmo comando, deixe rodando, não fale a
wake word. `noise-smoke.wav` (50s) já está commitado como smoke test; uma
sessão mais longa (≥15min) é o follow-up recomendado — nesse caso não
commitar o arquivo bruto: renomeie para bater no padrão `background-*.wav`
do `.gitignore` (ou ajuste o próprio `.gitignore` se decidir manter uma
versão maior como fixture).

## Depois de gravar

Siga a seção "Calibração" do [`README.md`](../README.md) deste diretório:
`--feature-stats` primeiro (confirma `FEATURE_SCALE`), depois `okay_nabu`
como controle, só então `hey_luna_trained`.
