# ADR 008 — Tempo e previsão via Open-Meteo, cache em vez de fetch síncrono

**Status:** Aceito
**Data:** 2026-08-25
**Contexto:** Tool `get_weather` ([docs/arquitetura-servidor.md](../arquitetura-servidor.md#previsão-do-tempo))

## Contexto

A Luna não sabia nada sobre o tempo. Perguntada "vai chover amanhã?", ela caía na
regra anti-alucinação do prompt ("Essa eu não sei") ou, pior, arriscava responder
de conhecimento paramétrico desatualizado do modelo — o próprio prompt já usava
temperatura como exemplo de unidade falada ("vinte e três graus") numa capacidade
que não existia.

Duas perguntas precisavam de resposta antes de escrever código: de onde vem o
dado, e como uma chamada de rede entra numa tool sem violar a meta de TTFAB
(< 800 ms), quando toda tool existente (`control_device`) só justifica seu
`await` por ser uma chamada LAN de 20-40 ms.

## Decisão

### Fonte: Open-Meteo, direto, sem chave

`api.open-meteo.com/v1/forecast` — gratuito, sem cadastro, sem API key, tier de
10 mil chamadas/dia. `fetch` nativo, sem dependência nova (o projeto mantém
deliberadamente 4 deps de runtime).

**Rejeitado: buscar via Home Assistant.** Seria LAN (~20-40 ms), mas
`HomeAssistantClient.getState()` descarta `attributes` (onde vivem temperatura e
condição de uma entidade `weather.*`) e `callService()` não manda `service_data`
nem o `?return_response` que `weather.get_forecasts` exige — exigiria estender o
cliente em dois pontos, e ainda ficaria refém de o HA ter uma integração de
clima configurada. Com o cache abaixo, a vantagem de latência do HA desaparece.

### O handler nunca faz round-trip

`weather/WeatherSource.ts` busca a previsão em background e mantém um snapshot
em memória, revalidado a cada `WEATHER_TTL_MS` (10 min) — o mesmo desenho do
`DeviceRegistrySource` para o Home Assistant: `start()`/`current()`/`refresh()`,
`setInterval(...).unref()`, e `refresh()` que **preserva o snapshot anterior**
quando o Open-Meteo falha. `getWeather.ts` (o handler da tool) só chama
`current()`, síncrono — nunca `fetch`.

Diferença deliberada em relação ao registro de dispositivos: um `WEATHER_MAX_STALE_MS`
(3h) faz `current()` devolver `null` para um snapshot velho demais. Um registro de
dispositivos velho ainda é útil; "vinte e três graus" de três horas atrás não é
mais verdade, e a tool prefere recusar a mentir com confiança.

Cache frio (primeiro pedido antes do primeiro `refresh()` bem-sucedido, ou
Open-Meteo fora do ar além do teto de idade) devolve `{ success: false, error }`
falável e dispara um `refresh()` em background, para a próxima pergunta ter
chance de acertar — sem fazer o turno atual esperar por ele.

### Escopo mínimo: um argumento, três valores

`get_weather(when?: 'now' | 'today' | 'tomorrow')`, schema plano (ADR 002).
Localização fixa em `WEATHER_LATITUDE`/`WEATHER_LONGITUDE` — a tool não recebe
cidade, não há geocoding. O mesmo princípio do `room_id` descartado em
`control_device`: o servidor já sabe onde é, o modelo não precisa adivinhar, e
cada schema a mais custa `model_decision_ms`.

`when` ausente tolerado como `'now'`: negar uma pergunta inofensiva por falta de
um enum daria "argumentos inválidos" na voz da Luna.

### `today`/`tomorrow` resolvidos pelo relógio único, nunca por posição

O `daily` do Open-Meteo vem em colunas paralelas (`time: [...]`, `weather_code:
[...]`); o handler casa a data por **string** (`formatLocalDate` de
`time/clock.ts`), nunca por índice fixo — um snapshot buscado antes da meia-noite
teria "hoje" na posição errada. "Amanhã" usa a mesma conta de `resolveOnce.ts`
(`localWallClockToUtc` da meia-noite de hoje + `24h`, válida porque São Paulo não
observa mais DST desde 2019). Mesma regra do ADR 006: o modelo manda a intenção,
o servidor resolve a data.

### Tradução para fala, no servidor

O modelo nunca recebe o `weather_code` (WMO) cru — `weather/wmo.ts` traduz para
texto em português (`3 → "nublado"`), e um código desconhecido **omite** o campo
em vez de inventar uma condição ("tempo instável" seria uma afirmação que
ninguém verificou). Temperaturas chegam arredondadas para inteiro: o modelo não
deve fazer `23.4 → "vinte e três vírgula quatro graus"`.

### Feature gate: sem localização, a tool nem existe

`WEATHER_LATITUDE`/`WEATHER_LONGITUDE` ausentes (as duas, validado em
`loadConfig`) fazem `index.ts` não construir `WeatherSource`, `RoomManager` não
declarar `GET_WEATHER_TOOL` ao modelo, e o prompt omitir a seção inteira. Um
schema que só sabe responder "não configurado" não deveria pagar orçamento de
instrução da sessão Live.

## Consequências

### Positivas

- "como está o tempo", "vai chover hoje/amanhã" respondidos com dado real, sem
  round-trip no caminho fala→resposta.
- Zero dependência nova.
- Cache com TTL mantém o uso bem abaixo do limite gratuito (~144 chamadas/dia).
- O padrão de `DeviceRegistrySource` se confirma reutilizável para a próxima
  fonte externa que precisar do mesmo desenho "buscar em background, servir de
  memória".

### Negativas

- **Primeira chamada HTTP do servidor a um serviço de terceiro fora da LAN.**
  Lat/lon saem para a internet — postura nova, ainda que o dado em si (duas
  coordenadas fixas, sem identificar pessoa) seja de baixo risco.
- Dado tem até `WEATHER_TTL_MS` de atraso: uma tempestade que começou agora
  aparece só no próximo refresh. Aceito — a alternativa é 150-400 ms de WAN em
  toda pergunta.
- Localização é da casa, não do dispositivo: o `luna-desktop` rodando fora de
  casa recebe o tempo de lá mesmo assim. Fora de escopo por decisão de produto
  (sem geocoding, sem parâmetro de cidade).
- Boot mais lento em até o timeout do primeiro fetch (3s) quando a rede está
  fora — mesmo custo que `deviceRegistry.start()` já tinha.
- Tier gratuito do Open-Meteo é para uso **não-comercial**; uso residencial está
  coberto.

## Alternativas consideradas

### Fetch síncrono dentro do handler (rejeitada)

Mais simples de implementar, mas coloca 150-400 ms de WAN direto no caminho
fala→resposta — o achado que o checklist de revisão do projeto existe
justamente para pegar. `controlDevice.ts` só aceita seu `await` porque é LAN.

### Cidade arbitrária com geocoding (rejeitada para esta versão)

Aceitar um argumento `city` livre e resolver com a Geocoding API do próprio
Open-Meteo. Adiciona um segundo round-trip, um ponto de alucinação (cidade
inventada ou ambígua) e mais latência — sem necessidade real: a casa não muda de
lugar. Pode voltar como extensão futura se aparecer o caso de uso.

### Fallback para o Home Assistant (rejeitada)

Ver "Fonte" acima. Descartada porque dobraria o código de cliente e de teste
sem ganho de latência, já que o cache elimina a vantagem que o HA teria.

## Referências

- [ADR 002](002-function-calling-contract.md) — contrato de tools, schema plano
- [ADR 006](006-agendamento-e-contrato-de-tempo.md) — relógio único, intenção vs. data absoluta
- [`luna-server/src/weather/`](../../luna-server/src/weather/)
- [Open-Meteo](https://open-meteo.com/)
