# Handoff: reduzir falso-positivo da wake word "Hey Luna"

Contexto: às vezes o "Hey Luna" dispara sozinho em frase aleatória. Análise completa e
o porquê provável (negativos de treino só em inglês, nenhuma frase pt-BR ensinada como
"isto não é a wake word") ficaram na conversa que gerou este handoff — o resumo
acionável está na nova seção **"Se o modelo dispara demais"** de
[`README.md`](README.md), que já reflete o código deste commit.

Esta sessão (cloud) não alcança `192.168.0.10` (LAN privada) nem tem microfone para
gravar áudio — por isso as duas partes abaixo ficam para uma sessão local.

O que já foi feito neste commit (revise antes de rodar):

- `scripts/04b_generate_custom_negatives.py` — gera features de negativos pt-BR a
  partir de WAVs em `work/custom_negatives_wav/` (pasta vazia por padrão → etapa
  no-op).
- `scripts/05_write_training_config.py` — inclui cada grupo (`fundo`,
  `confundiveis`) como negativo automaticamente **se as features existirem**, com
  pesos próprios (`CUSTOM_PTBR_GROUPS`).
- `run.sh` — novo passo `custom_negatives`, incluído em `./run.sh all` logo após
  `negatives`.
- `README.md` — seção nova com o passo a passo completo (recalibrar cutoff → negativos
  customizados → SpecAugment/pesos, nessa ordem de custo).

## Parte 1 — gravar os negativos pt-BR (precisa de gente e microfone)

> **Status (2026-09-25):** primeira leva pronta na máquina local, em
> `wake-training/work/custom_negatives_wav/` (fora do git — copiar para o servidor,
> ver Parte 2):
> - `confundiveis/frases_parecidas_whatsapp.wav` — 15 s de frases gravadas (28 janelas).
>   Pouco áudio: gravar mais (vozes diferentes, mais variações) é a melhoria mais barata.
> - `fundo/tv_conversa_yt.wav` — 21:50 de conversa pt-BR tirada de um vídeo do YouTube
>   (`s5y9RxnLw5A`), convertida para 16 kHz mono (437 janelas).

1. Grave (celular serve, 16kHz+ mono é suficiente) alguns clipes de:
   - TV/rádio em português, conversa de fundo normal em casa.
   - As frases mais parecidas foneticamente com "hey luna": "lua", "uma", "luna" sem o
     "hey", "e aí, Luna?", nomes parecidos (Ana, Duda, etc.).
2. Salve cada clipe como `.wav` em `wake-training/work/custom_negatives_wav/fundo/`
   (TV/conversa, mínimo ~30 s) ou `.../confundiveis/` (frases parecidas, mínimo ~6 s).
   Não precisa recortar preciso: o script corta em janelas sozinho.
3. Se preferir um atalho maior que gravação manual: um recorte do Common Voice pt-BR
   (fala variada, licença permissiva) também serve como negativo geral — só não
   substitui as frases confundíveis do item acima, que são o ponto principal.

Isso não precisa acontecer antes do treino começar — dá pra já subir o pipeline até
`negatives` no servidor enquanto isso é gravado, e só rodar `custom_negatives` +
`train` depois. Ver ordem na Parte 2.

## Parte 2 — rodar o treino no servidor (`192.168.0.10`), não na máquina principal

O servidor já roda o `luna-server` de produção (ver `luna-server/deploy/README.md`) —
**não** derrube nem compita pesado com ele sem necessidade:

- Antes de começar: `free -h` e `df -h` no servidor. Treinos anteriores vazaram até
  ~11.7GB de RAM (vazamento do TF, ver comentário em `06b_train_loop.sh`) — e o Docker
  **não** limita memória nem CPU por padrão: sem limite, o OOM killer do host pode matar
  o `luna-server` em vez do treino.
- Por isso rode **sempre** com `MWW_DOCKER_ARGS="--memory=<RAM livre menos folga> --cpus=<núcleos - 1>"`
  (o `run.sh` repassa isso ao `docker run`). Se o treino morrer com OOM (código 137),
  basta rodar `./run.sh train` de novo: ele retoma do último checkpoint. Monitore
  os primeiros minutos para garantir que o `luna-server` continua respondendo
  (`curl localhost:<WS_PORT>/health` — porta em `/etc/luna-server.env`) antes de deixar
  rodando por horas sem supervisão.
- **Use `tmux`/`screen`** para a sessão de treino sobreviver ao SSH cair — é o ponto
  principal de rodar no servidor em vez da máquina principal (o treino leva horas).

Passo a passo:

```bash
ssh <usuario>@192.168.0.10

# clonar (ou usar um checkout que já exista) só o necessário — não precisa do
# repo inteiro se já houver um clone do luna-server ali; se não houver:
git clone https://github.com/dioguit0s/luna-assistant.git ~/luna-wake-training
cd ~/luna-wake-training
git checkout main   # o pipeline de negativos pt-BR já está no main
git pull
cd wake-training

docker build -t mww-train .

# os WAVs da Parte 1 vivem fora do git — da máquina local (Git Bash), antes de
# custom_negatives (o `mkdir` é no servidor, o scp sai da máquina local):
mkdir -p work
#   scp -r "wake-training/work/custom_negatives_wav" <usuario>@192.168.0.10:~/luna-wake-training/wake-training/work/

tmux new -s wake-train
# dentro do tmux (ajuste os limites ao que `free -h`/`nproc` mostrarem):
export MWW_DOCKER_ARGS="--memory=8g --cpus=3"
./run.sh samples
./run.sh augdata
./run.sh negatives
# neste ponto dá pra Ctrl+B D (detach) e esperar a Parte 1 terminar, ou já
# rodar custom_negatives vazio (no-op) e re-rodar depois que os WAVs chegarem —
# o passo sempre regenera a partir dos WAVs (sem WAVs, apaga a saída antiga).
./run.sh custom_negatives   # depois que work/custom_negatives_wav/ tiver os WAVs da Parte 1
./run.sh features
./run.sh train               # a etapa longa — horas, é para isto que o tmux existe
./run.sh export
```

Para reconectar depois de sair: `tmux attach -t wake-train`.

## Depois que `export` terminar

Segue exatamente o que já está documentado em `README.md` → "Depois do treino" e em
`../luna-firmware/models/TRAINING.md`: copiar `.tflite`/`.json` para
`luna-firmware/models/`, gerar o header, **recalibrar `WAKE_PROB_CUTOFF` com o
microfone real** (não confiar no valor do manifesto), e testar com ≥15 min de
conversa/TV em pt-BR antes de considerar resolvido — é exatamente o teste que faltou
da última vez (só 50s de ruído sem fala).

Se o falso-positivo sumir mas o recall cair muito (modelo fica "surdo"), o peso do
grupo `confundiveis` em `CUSTOM_PTBR_GROUPS` (`05_write_training_config.py`) é o
primeiro parâmetro a reduzir.
