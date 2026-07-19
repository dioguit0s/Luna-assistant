# Luna Infra

Infraestrutura de automação residencial do Projeto Luna — Épico 3 (LUNA-301).

## Host alvo

Servidor Ubuntu Server dedicado em `192.168.0.10`. Todo o restante deste
documento assume esse host.

Requisitos:

- Docker Engine >= 24 com plugin `docker compose`
- **Linux** — `network_mode: host` só funciona em Linux. Docker Desktop
  (Windows/macOS) não expõe a LAN ao container e a descoberta mDNS falha.
- Servidor e satélites ESPHome na **mesma rede L2/VLAN** (mDNS não atravessa
  roteador). Ambos em `192.168.0.0/24`.
- IP fixo no servidor — o `luna-server` aponta para `192.168.0.10:8123` e uma
  troca via DHCP quebraria a integração.

## Subir

```bash
cd infra
docker compose up -d
```

Acesse `http://192.168.0.10:8123` e conclua o onboarding do Home Assistant
(criação do usuário administrador).

## Comandos úteis

```bash
docker compose logs -f homeassistant   # acompanhar logs
docker compose restart homeassistant   # reiniciar
docker compose down                    # parar (config persiste em ./homeassistant/config)
docker compose pull && docker compose up -d   # atualizar imagem
```

## Portas

| Porta | Serviço | Uso |
|-------|---------|-----|
| 8123 | Home Assistant | UI web e API REST/WebSocket consumida pelo `luna-server` |
| 5353/udp | mDNS | Descoberta automática dos dispositivos ESPHome |
| 8080 | `luna-server` | WebSocket dos satélites e `GET /health`. Serviço systemd, fora do compose — ver [luna-server/deploy](../luna-server/deploy/README.md) |
| 6379 | Redis | **Desativado** — serviço comentado, previsto no Épico 4 |

Em `network_mode: host` não há mapeamento de portas: o Home Assistant escuta
diretamente nas interfaces do servidor.

Se o `ufw` estiver ativo no Ubuntu, libere o necessário:

```bash
sudo ufw allow from 192.168.0.0/24 to any port 8123 proto tcp
sudo ufw allow from 192.168.0.0/24 to any port 5353 proto udp
sudo ufw allow from 192.168.0.0/24 to any port 8080 proto tcp
```

## `luna-server`

O `luna-server` **não** roda neste compose: ele é um serviço systemd no mesmo
host, atualizado automaticamente a cada push na `main`. Setup e operação em
[`luna-server/deploy/README.md`](../luna-server/deploy/README.md).

## Áreas e `room_id` (LUNA-302)

As áreas do Home Assistant são a fonte de verdade para os `room_id` do projeto.
O orquestrador isola contexto conversacional por `room_id` e o satélite envia
esse valor em cada pacote, então **o `area_id` no HA e o `ROOM_ID` no firmware
precisam ser idênticos** — string exata, incluindo underscores.

Áreas definidas na casa:

| `area_id` (= `room_id`) | Nome no HA |
|-------------------------|------------|
| `sala_de_estar` | Sala de estar |
| `cozinha` | Cozinha |
| `quarto` | Quarto |

Essas três foram criadas no onboarding e são as áreas definitivas — não há
`oficina`. Ao adicionar um cômodo novo, crie a área no HA primeiro
(*Configurações → Áreas e zonas*) e use o `area_id` gerado como `ROOM_ID` do
satélite, nunca o inverso: o HA deriva o `area_id` do nome (slug com
underscores) e não aceita alteração posterior sem recriar a área.

Conferir os `area_id` atuais:

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  http://192.168.0.10:8123/api/template \
  -X POST -d '{"template": "{{ areas() }}"}'
# ['sala_de_estar', 'cozinha', 'quarto']
```

Trocar por `{{ areas() | map("area_name") | list }}` devolve os nomes legíveis
em vez dos ids.

## Token de acesso (LUNA-302)

O `luna-server` autentica na API do HA com um Long-Lived Access Token. Gere em:
perfil do usuário → aba **Segurança** → **Long-Lived Access Tokens** → *Criar
token*. O valor é exibido uma única vez; cole em `luna-server/.env` como
`HA_TOKEN`.

O token não expira, mas é invalidado se o usuário que o criou for removido ou se
for revogado na mesma tela. Validar:

```bash
curl -H "Authorization: Bearer $HA_TOKEN" http://192.168.0.10:8123/api/
# {"message": "API running."}
```

Um `401: Unauthorized` aqui significa token inválido ou revogado — o `HA_URL`
pode ser conferido à parte com `curl http://192.168.0.10:8123/api/onboarding`,
que responde sem autenticação.

## Persistência

A configuração vive em `infra/homeassistant/config` (bind mount para `/config`),
fora do ciclo de vida do container. `docker compose down && docker compose up -d`
preserva usuários, integrações e automações.

Esse diretório **não é versionado** — contém segredos e o banco de estado
(`home-assistant_v2.db`). Faça backup dele separadamente.

## Hardware USB

O compose não usa `privileged` nem monta `/run/dbus`, porque os satélites do
Épico 3 falam ESPHome sobre Wi-Fi. Caso entre um adaptador Zigbee/Z-Wave USB no
servidor, adicione ao serviço:

```yaml
    privileged: true
    volumes:
      - /run/dbus:/run/dbus:ro
```

## Redis (Épico 4)

O serviço está declarado e comentado no `docker-compose.yml`. Quando o Épico 4
substituir o `Map` em memória do orquestrador, basta descomentar o bloco e subir
novamente com `docker compose up -d`.

## Verificação (critério de aceite LUNA-301)

No servidor:

1. `cd infra && docker compose up -d`
2. `docker compose ps` — serviço em estado `running`
3. De outra máquina da LAN, abrir `http://192.168.0.10:8123` e concluir o onboarding
4. `docker compose restart homeassistant`
5. Recarregar a página — o login criado no passo 3 continua válido
