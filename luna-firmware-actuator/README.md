# luna-firmware-actuator — Atuador Físico (Épico 3)

Firmware ESPHome do segundo ESP32 do projeto: o que age no mundo físico. Expõe
uma entidade `switch` ao Home Assistant por Wi-Fi, que o `luna-server` aciona
via API do HA quando o function calling reconhece um comando de dispositivo
(LUNA-304/305).

Substitui o par Arduino Uno + cabo serial do desenho original — não há cabo
entre servidor e atuador.

## Hardware

Placa: **ESP32 DevKit v1** (ESP32-WROOM-32). Não é o ESP32-S3 do satélite do
Épico 2 — a pinagem deste diretório não tem relação com a
[`docs/PINAGEM_EPICO_2.md`](../docs/PINAGEM_EPICO_2.md).

| GPIO | Componente | Função | Direção |
|------|-----------|--------|---------|
| GPIO2 | LED azul embutido | Luz de bancada (carga simulada) | ESP32 → LED |

> **Não há fiação.** Nada é ligado à placa: a carga é o LED que já vem soldado
> no DevKit. O que se valida aqui é o caminho de controle
> `luna-server → Home Assistant → ESP32`, e para isso um LED prova exatamente o
> mesmo que um relay provaria — com a vantagem de não haver 127V envolvido.
>
> Se um relay entrar no projeto depois, é o `pin:` que muda (e módulos relay
> costumam ser *active-low*, exigindo `inverted: true`). O `entity_id` e o resto
> do arquivo continuam iguais.

## Configuração

```bash
cd luna-firmware-actuator
cp secrets.yaml.example secrets.yaml
```

Preencha o `secrets.yaml`. A `api_encryption_key` precisa ser uma chave base64
de 32 bytes:

```bash
openssl rand -base64 32
```

No Windows sem `openssl`, pelo PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

> O `secrets.yaml` está no `.gitignore` da raiz. **Não comitar.**
>
> Guarde a `api_encryption_key` — o Home Assistant vai pedi-la ao adicionar o
> dispositivo, e ela não é recuperável depois de gravada no ESP32.

## Flash inicial via USB

O Home Assistant deste projeto roda em Docker puro, não em HAOS — **não existe
o add-on ESPHome**. O toolchain é o CLI, na máquina de desenvolvimento:

```bash
pip install esphome
esphome version
```

Validar o YAML antes de encostar no hardware:

```bash
esphome config luz-bancada.yaml
```

Com o ESP32 no USB:

```bash
esphome run luz-bancada.yaml
# escolha a porta serial (ex.: COM3) na lista apresentada
```

A primeira compilação baixa o ESP-IDF e leva vários minutos; as seguintes são
rápidas (cache em `.esphome/`, também ignorado pelo Git).

Armadilhas do primeiro flash:

| Sintoma | Causa | Correção |
|---|---|---|
| Nenhuma porta COM aparece | driver USB-serial ausente | instalar CP2102 (Silicon Labs) ou CH340, conforme o chip da placa |
| `Failed to connect to ESP32` | placa não entrou em modo de gravação | segurar **BOOT**, tocar **EN/RST**, soltar **BOOT** ao aparecer "Connecting..." |
| Grava mas não conecta ao Wi-Fi | SSID/senha errados, ou rede em 5GHz | o ESP32 é **2.4GHz apenas**; conferir o `secrets.yaml` |
| Placa não entra em modo de gravação **depois** de já estar com o firmware | GPIO2 é strapping pin e estava em nível alto no reset (LED aceso) | desligar o switch pelo HA antes do flash, ou usar OTA |

Após gravar, o `esphome run` deixa os logs abertos. Confirme:

```
[wifi] WiFi Connected ...
[wifi] IP Address: 192.168.0.xxx
```

## Atualizações via OTA

Com o node já na rede, o cabo não é mais necessário:

```bash
esphome run luz-bancada.yaml
# escolha "OTA (luz-bancada.local)" em vez da porta serial
```

Requer o PC e o ESP32 na **mesma rede L2/VLAN** (`192.168.0.0/24`) — o mDNS não
atravessa roteador, mesma restrição documentada em
[`infra/README.md`](../infra/README.md).

Se o `.local` não resolver no Windows (mDNS costuma falhar lá), use o IP direto:

```bash
esphome run luz-bancada.yaml --device 192.168.0.xxx
```

Acompanhar os logs sem regravar:

```bash
esphome logs luz-bancada.yaml
```

## Integração com o Home Assistant

1. O HA descobre o node por mDNS: **Configurações → Dispositivos e serviços**,
   o ESPHome aparece em *Descobertos*. Se não aparecer, adicionar manualmente
   pelo host `luz-bancada.local` (ou o IP).
2. O HA pede a **chave de criptografia** — é a `api_encryption_key` do
   `secrets.yaml`.
3. Atribuir o dispositivo à área **`quarto`**.
4. Confirmar o entity_id gerado: **`switch.luz_bancada`**.

> O entity_id é contrato com o `luna-server`: a LUNA-305 envia
> `{"function":"control_device","device":"luz_bancada","action":"on","room_id":"quarto"}`
> e o despacho monta o `entity_id` a partir do campo `device`. Se o HA gerar um
> id diferente (acontece se alguém adicionar `friendly_name` ao YAML, ou se já
> existir outra entidade com esse nome), o comando falha silenciosamente com
> `entity not found`.

Verificar pela API:

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  http://192.168.0.10:8123/api/states/switch.luz_bancada
```

## Verificação (critério de aceite LUNA-303)

1. `esphome config luz-bancada.yaml` — YAML válido e `!secret` todos resolvidos.
2. `esphome run luz-bancada.yaml` pela porta COM — compila e grava.
3. Nos logs que seguem abertos: `WiFi Connected` com IP na `192.168.0.0/24`.
4. Adicionar a integração ESPHome no HA e acionar `switch.luz_bancada` pela
   interface — **o LED azul acende e apaga**, e o log mostra
   `'luz_bancada' Turning ON/OFF`.
5. Desconectar o USB, alimentar por fonte, e rodar `esphome run` escolhendo OTA
   — confirma a atualização sem cabo.

## Estado

- Entidade `switch.luz_bancada` no GPIO2 (LED onboard) ✅
- API nativa com criptografia + OTA com senha ✅
- Despacho pelo `luna-server` — LUNA-304/305
