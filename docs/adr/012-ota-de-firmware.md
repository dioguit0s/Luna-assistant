# ADR 012 — OTA de firmware: release no GitHub, servidor como proxy, rollback por autenticação

**Status:** Proposto
**Data:** 2026-11-17
**Contexto:** Painel de controle, seção Satélites ([painel-de-controle.md](../painel-de-controle.md)); protocolo ([protocolo-websocket.md](../protocolo-websocket.md#atualização-de-firmware-ota_start--ota_progress--ota_result))

## Contexto

Atualizar um satélite exigia tirá-lo do lugar, ligar no USB e rodar `pio run -t upload`
com o `secrets.h` local. A tabela de partições (`default_16MB.csv`) já tem `app0` e
`app1` de 6,5 MB, então a placa comporta OTA; faltavam o binário publicado, o canal
para mandar o satélite atualizar e uma forma de não brickar um satélite instalado
no teto com uma imagem ruim.

Restrições:

1. **O repositório é público.** Qualquer binário publicado vai para qualquer um, então
   ele não pode carregar Wi-Fi, IP do servidor, sala nem segredo. Desde o
   `ConfigStore` (issue #29) essa configuração vive na NVS, e um binário genérico
   funciona em qualquer satélite já provisionado.
2. **O satélite é um ESP32 sem relógio nem loja de certificados.** Falar TLS com o
   GitHub (e seguir os redirects para o storage dele) exigiria embutir e manter CA no
   firmware e hora certa, para baixar 1,5 MB uma vez por mês.
3. **Ninguém vai ver o satélite falhar.** Uma imagem que não sobe o Wi-Fi ou não
   autentica deixa o satélite surdo até alguém subir numa escada com um cabo.

## Decisão

1. **Release pelo CI, disparada por tag.** A tag `fw-vX.Y.Z` roda
   `.github/workflows/firmware-release.yml` num runner hospedado: `pio run` **sem**
   `secrets.h` e com `-DLUNA_RELEASE_BUILD=1`, guard de vazamento, `manifest.json`
   (`version`, `build`, `commit`, `size`, `sha256`, `date`, `changelog`) e GitHub
   Release com `firmware.bin` + `manifest.json`. A versão embutida vem da tag
   (`LUNA_FW_VERSION`), o build é o SHA curto do commit (`LUNA_FW_BUILD`) — o mesmo
   `build` do manifest.
2. **Nenhum segredo no binário, em três barreiras.** (a) Com `LUNA_RELEASE_BUILD`, o
   `main.cpp` falha com `#error` se houver `secrets.h` e tem `static_assert` exigindo
   cada credencial compilada vazia. (b) `tools/check_release_binary.py` procura no
   `.bin` os placeholders do `.example`, os valores do `secrets.h` local (quando
   existe) e a lista do secret `FW_FORBIDDEN_STRINGS`; achou, o job falha antes de
   publicar. (c) O binário só funciona com a NVS já provisionada por USB.
   Por que **não** compilar com o `secrets.h.example`: ele tem placeholders não
   vazios (`dev-secret-change-me`, `sala_de_estar`) que iriam para o binário e
   semeariam a NVS de um satélite novo com lixo.
3. **O servidor é o proxy.** `GET /admin/v1/firmware/releases` consulta a API pública
   do GitHub (cache de 5 min). `POST /admin/v1/satellites/:id/ota { version }` faz o
   servidor baixar o `.bin`, conferir tamanho e SHA-256 contra o manifest e servi-lo
   na LAN em `GET /ota/<token>.bin`: token aleatório de 128 bits, uso único, 10 min,
   preso ao IP do satélite, fora da API admin (o satélite não tem o token admin). O
   host da URL é o endereço local do socket WebSocket daquele satélite — o IP que ele
   já usa para falar com o servidor. Download que não confere nunca vira `ota_start`.
4. **O satélite puxa, confere de novo e só então troca o boot.** `ota_start { url,
   version, sha256, size }` → task de download (`HTTPClient` + `esp_ota_*` com escrita
   sequencial) que calcula o SHA-256 enquanto grava. Tamanho ou hash diferente:
   `esp_ota_abort` e o satélite segue na versão atual. Conferiu: `esp_ota_end`
   (valida o formato da imagem) e `esp_ota_set_boot_partition`, `ota_result { ok }` e
   reinício. Não usamos `HTTPUpdate`/`Update`: eles trocam o boot sem permitir
   conferir o SHA-256 do manifest antes.
5. **Rollback por autenticação.** O bootloader do core Arduino já vem com
   `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`. O firmware define `verifyRollbackLater()`
   para o core não validar a imagem sozinho no boot; ela só é marcada válida
   (`esp_ota_mark_app_valid_cancel_rollback`) no `auth_ok`. Sem autenticar em
   `OTA_VALIDATE_TIMEOUT_MS` (5 min), o próprio firmware a marca inválida e reinicia
   na anterior; crash ou boot loop antes disso são revertidos pelo bootloader.
6. **A confirmação é o `device_info`.** Depois do reinício, o `device_info` da conexão
   nova com a versão e o build do alvo fecha a OTA como `ok`; outra versão é
   `rolled_back`. Sem voltar em 7 min, `failed`.
7. **Regras de concorrência.** Uma OTA por satélite; satélite fora de
   `IDLE_LISTENING` responde `ocupado` (mesma regra do `set_config`, inclusive a
   exceção do open-mic). Durante a OTA a wake word e o envio de áudio ficam
   desligados e o LED pisca num padrão próprio. Uma queda do WebSocket no meio não
   encerra a OTA (o download não depende dele): quem decide é o progresso seguinte,
   o prazo sem progresso (60 s) ou o `device_info` na versão do alvo.

Estado das OTAs: em memória, no `OtaManager` (`luna-server/src/ota/`). Restart do
servidor esquece o acompanhamento, não o satélite.

## Consequências

- **Um satélite tem que receber uma vez por USB** o firmware com OTA (0.6.0+):
  firmware anterior ignora `ota_start` e o painel mostra "firmware anterior à OTA".
  O bootloader não muda por OTA; o que vem com o core já tem rollback.
- Wi-Fi caído por mais de 5 min logo depois de uma OTA boa reverte para a versão
  anterior. Aceito: é recuperável (repetir a OTA) e o contrário — validar sem prova
  — não é.
- `ota_result` e `device_info` precisam do servidor de pé; o satélite não sabe quem
  pediu nem guarda histórico.
- Nenhum token do GitHub é necessário (repositório público, 60 req/h com cache de
  5 min). `FIRMWARE_RELEASES_TOKEN` existe só para subir o limite.
- O guard só acha o que sabe procurar: sem `FW_FORBIDDEN_STRINGS` configurado no
  repositório, ele confere só os placeholders. A barreira (a) continua valendo.
- **Risco aceito: a imagem não é assinada.** O satélite grava qualquer imagem que um
  `ota_start` do servidor ao qual está conectado mandar — a URL, o SHA-256 e o tamanho
  vêm na mesma mensagem, por `ws://` em claro, e o `auth_ok` não prova que o servidor
  conhece o `WS_AUTH_SECRET`. Quem conseguir se passar pelo servidor na LAN (tomar o IP,
  ARP spoofing) consegue **regravar o firmware** de forma persistente; o rollback não
  protege, porque uma imagem maliciosa autentica no servidor falso e é validada. Antes
  da OTA, o mesmo atacante só conseguia ouvir ou injetar áudio. Aceito por ora porque a
  LAN da casa já é a fronteira de confiança de todo o resto (HA, servidor, admin por
  rede privada). Mitigação planejada, nesta ordem: (1) assinar o `.bin` no CI com
  ed25519 e o firmware conferir com a chave pública compilada antes de trocar o boot;
  (2) o servidor provar o segredo no `auth_ok` (HMAC de um nonce do satélite). Do lado
  do GitHub: quem publicar uma release `fw-v*` no repositório controla o firmware dos
  satélites que alguém mandar atualizar.
- Reinstalar a mesma versão e o mesmo build não tem como detectar reversão (a imagem
  anterior é idêntica): o painel não oferece essa opção.
- Falha por prazo no servidor não cancela o satélite (a task de download não é
  cancelável). Se ele voltar na versão do alvo, a OTA é promovida de `failed` a `ok`;
  um `ota_start` novo enquanto a anterior ainda grava é recusado com "atualização já em
  andamento".
