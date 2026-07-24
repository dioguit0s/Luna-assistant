# Treinar a wake word "Ei Luna" / "Hey Luna"

Não existe modelo pronto de "Luna" que preste (os `hey_luna*` da comunidade são fracos e não
disparam no nosso INMP441 — ver [README.md](README.md)). O `okay_nabu` provou que o hardware está
bom, então falta um modelo **bem treinado** para a nossa palavra. Este é o passo que fecha o A1.

## Por que treinar, e com o quê

O que separa um modelo que dispara de um que não dispara **não é a frase** — é a **augmentation**
no treino (ruído, reverb, variação de voz). O `okay_nabu` funciona porque foi treinado com isso; os
`hey_luna` não. Qualquer treino novo precisa herdar essa augmentation.

## Caminho recomendado: trainer hospedado

1. Acesse <https://microwakeword.com/train>.
2. Frase: **`hey luna`** (recomendado) ou `ei luna`. Evite só "luna" — palavra de 2 sílabas dá
   muito falso-positivo (foi por isso que a comunidade usou o prefixo "hey").
3. Deixe a augmentation no padrão (é ela que faz funcionar no mic real).
4. Rode o treino (~minutos) e baixe os dois artefatos: **`<nome>.tflite`** e **`<nome>.json`**
   (o manifesto com `probability_cutoff`, `sliding_window_size`, `tensor_arena_size`).

> Se o trainer hospedado não bastar (rejeição alta com o seu sotaque), o caminho seguinte é o
> `basic_training_notebook.ipynb` do [microWakeWord](https://github.com/kahrendt/microWakeWord),
> que aceita **amostras gravadas com o seu microfone** — aí o modelo aprende a resposta do
> INMP441 e a sua pronúncia. Mais trabalhoso, mas é o teto de robustez.

## Integrar no firmware (já está tudo pronto para receber)

O firmware lê o `stride` do próprio tensor e testa o tamanho da arena sozinho, então trocar de
modelo é mecânico:

1. Ponha o `.tflite` e o `.json` em `luna-firmware/models/`.
2. Gere o header:
   ```bash
   python tools/tflite_to_header.py models/hey_luna.tflite src/wake/models/hey_luna_model_data.h g_hey_luna_model_data
   ```
3. Em [`include/config.h`](../include/config.h), reveja com base no manifesto novo:
   - `WAKE_PHRASE` → `"Hey Luna"`
   - `WAKE_PROB_CUTOFF` → comece no valor do manifesto (ex. 0.97) e **afine pelo `raw_max`** do log
     de debug (`WAKE_DEBUG 1`) falando no mic real: se `raw_max` bate ~250 ao dizer a frase mas a
     média não cruza, baixe; se dispara com TV/conversa, suba.
   - `WAKE_SLIDING_WINDOW` → do manifesto, se diferente.
   - `WAKE_ARENA_BYTES` → `tensor_arena_size` do manifesto + folga (~10%); se ficar curto o boot
     loga o valor efetivo e dobra sozinho.
4. `pio run -t upload && pio device monitor` e valide com a frase.

## Verificar antes de considerar pronto

- Dizer "Hey Luna" a ~1 m e a ~3 m: `[wake] DETECTADO` e LED acende.
- 30 min de TV/conversa normal sem disparar (se disparar, suba `WAKE_PROB_CUTOFF`).
- Quando estabilizar, desligue `WAKE_DEBUG` em `config.h` (economiza CPU/serial).
