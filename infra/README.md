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
| 6379 | Redis | **Desativado** — serviço comentado, previsto no Épico 4 |

Em `network_mode: host` não há mapeamento de portas: o Home Assistant escuta
diretamente nas interfaces do servidor.

Se o `ufw` estiver ativo no Ubuntu, libere o necessário:

```bash
sudo ufw allow from 192.168.0.0/24 to any port 8123 proto tcp
sudo ufw allow from 192.168.0.0/24 to any port 5353 proto udp
```

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
