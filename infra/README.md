# Luna Infra

Infraestrutura de automação residencial do Projeto Luna — Épico 3 (LUNA-301).

## Pré-requisitos

- Docker Engine >= 24 com plugin `docker compose`
- **Host Linux** — `network_mode: host` só funciona em Linux. No Docker Desktop
  (Windows/macOS) o container não enxerga a rede da LAN e a descoberta mDNS dos
  dispositivos ESPHome falha. Ver [Rodando fora do Linux](#rodando-fora-do-linux).
- Servidor na **mesma rede L2/VLAN** dos ESP32 com ESPHome (mDNS não atravessa roteador).

## Subir

```bash
cd infra
docker compose up -d
```

Acesse `http://<ip-do-servidor>:8123` e conclua o onboarding do Home Assistant
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

## Persistência

A configuração vive em `infra/homeassistant/config` (bind mount para `/config`),
fora do ciclo de vida do container. `docker compose down && docker compose up -d`
preserva usuários, integrações e automações.

Esse diretório **não é versionado** — contém segredos e o banco de estado
(`home-assistant_v2.db`). Faça backup dele separadamente.

## Redis (Épico 4)

O serviço está declarado e comentado no `docker-compose.yml`. Quando o Épico 4
substituir o `Map` em memória do orquestrador, basta descomentar o bloco e subir
novamente com `docker compose up -d`.

## Rodando fora do Linux

Para desenvolvimento em Windows/macOS, troque `network_mode: host` por
publicação de porta:

```yaml
    ports:
      - "8123:8123"
```

A UI fica acessível, mas a descoberta mDNS dos ESPHome não funciona — os
dispositivos precisam ser adicionados manualmente por IP. Para a homologação do
Épico 3, use um host Linux.

## Verificação (critério de aceite LUNA-301)

1. `docker compose up -d`
2. Abrir `http://<ip-do-servidor>:8123` e concluir o onboarding
3. `docker compose restart homeassistant`
4. Recarregar a página — o login criado no passo 2 continua válido
