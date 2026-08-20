# Deploy do luna-server

Todo push na branch `main` que toque `luna-server/**` dispara o workflow
[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml), que roda num
**self-hosted runner** dentro do servidor Ubuntu (`192.168.0.10`) e atualiza o serviço.

O runner é usado porque o servidor está numa LAN privada — runners hospedados do
GitHub não o alcançam. A conexão é *outbound*, então nenhuma porta precisa ser
aberta no roteador.

## Fluxo de um deploy

1. `npm ci` → `npm test` → `npm run build` no workspace do runner.
   Se os testes falharem, o job para aqui e **a versão em produção continua no ar**.
2. A build é copiada para `/opt/luna/releases/<sha>` e recebe `npm ci --omit=dev`.
3. [`activate.sh`](./activate.sh) troca atomicamente o symlink `/opt/luna/current`,
   reinicia o serviço e valida `GET /health` por até 20s. A porta é lida do
   `WS_PORT` em `/etc/luna-server.env` — ver [Porta](#porta) abaixo.
4. Se o health check falhar, o symlink volta para a release anterior, o serviço é
   reiniciado e o job falha (vermelho na aba Actions).
5. Releases antigas são podadas, mantendo as 5 mais recentes.

## Layout no servidor

```
/opt/luna/
  releases/<sha>/        dist/ + package.json + package-lock.json + node_modules
  current -> releases/<sha>
/etc/luna-server.env     segredos (root:luna 0640) — fora do repositório
/opt/actions-runner/     runner do GitHub, rodando como serviço
```

## Setup inicial (uma única vez)

Executado via SSH no servidor. `<runner-user>` é o usuário que roda o runner.

### 1. Node 20+ e git

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git curl
```

### 2. Usuário de serviço e diretórios

```bash
sudo useradd --system --home /opt/luna --shell /usr/sbin/nologin luna
sudo mkdir -p /opt/luna/releases
# O runner escreve as releases; o usuário `luna` só precisa ler/executar.
sudo chown -R <runner-user>:luna /opt/luna
sudo chmod -R 2775 /opt/luna
```

### 3. Segredos

```bash
sudo cp luna-server/.env.example /etc/luna-server.env
sudo nano /etc/luna-server.env   # preencher GEMINI_API_KEY, WS_AUTH_SECRET, HA_TOKEN
sudo chown root:luna /etc/luna-server.env
sudo chmod 0640 /etc/luna-server.env
```

> `WS_AUTH_SECRET` precisa ser **idêntico** ao valor compilado no firmware
> (`luna-firmware/include/secrets.h`). Trocar aqui sem reflashar os satélites
> derruba a autenticação deles.

O runner precisa ler esse arquivo para descobrir a `WS_PORT` no health check:

```bash
sudo usermod -aG luna ash   # o grupo dá leitura via modo 0640 root:luna
```

Aplique com `sudo systemctl restart actions.runner.*` (ou reboot) — o runner só
enxerga o novo grupo depois de reiniciar.

### 4. Serviço systemd

```bash
sudo cp luna-server/deploy/luna-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable luna-server
# Ainda não dá `start`: /opt/luna/current só existe após o primeiro deploy.
```

### 5. Self-hosted runner

No GitHub: **Settings → Actions → Runners → New self-hosted runner (Linux x64)**.
Seguir as instruções da página, instalando em `/opt/actions-runner`, com os labels
`self-hosted,linux,luna` (o workflow depende do label `luna`). Instalar como serviço:

```bash
cd /opt/actions-runner
./svc.sh install       # roda como o usuário atual — NÃO use root
./svc.sh start
```

### 6. sudoers para o restart

```bash
sudo visudo -f /etc/sudoers.d/luna-deploy
```

```
<runner-user> ALL=(root) NOPASSWD: /usr/bin/systemctl restart luna-server, /usr/bin/systemctl status luna-server
```

### 7. Firewall

```bash
sudo ufw allow from 192.168.0.0/24 to any port "$WS_PORT" proto tcp
```

## Porta

`WS_PORT` em `/etc/luna-server.env` é a **única** fonte de verdade do lado do
servidor — o `activate.sh` lê dali para montar a URL do health check, então
trocar a porta não exige mexer em nenhum arquivo do repositório.

Mas a porta também aparece, hardcoded, em dois lugares fora do servidor:

| Onde | O que fazer ao trocar a porta |
|---|---|
| `luna-firmware/include/secrets.h` (`LUNA_PORT`) | Editar e **reflashar** cada satélite — o valor é compile-time |
| `luna-client-test/.env` (`WS_SERVER_URL`) | Editar a URL |

Trocar `WS_PORT` sem atualizar o firmware deixa os satélites tentando conectar
na porta antiga indefinidamente. Também lembre da regra `ufw` para a porta nova.

### 8. Primeiro deploy

Rodar o workflow manualmente (**Actions → Deploy luna-server → Run workflow**) ou
fazer um push em `main`.

## Estado persistente

O serviço grava um banco SQLite com os lembretes e alarmes. A unit declara
`StateDirectory=luna-server`, então o systemd cria `/var/lib/luna-server` com
dono `luna:luna` e libera escrita mesmo sob `ProtectSystem=strict` — não é
preciso criar o diretório nem ajustar permissão à mão.

O banco **não** fica junto da release: o `activate.sh` troca o symlink de
`/opt/luna/current` a cada deploy e poda as antigas, então um alarme marcado
para as 7h não sobreviveria a um deploy às 3h. Para apontar para outro caminho,
use `LUNA_DB_PATH` (absoluto) em `/etc/luna-server.env`.

O `node:sqlite` exige **Node >= 22.5**. O workflow não tem `setup-node` — usa o
node da máquina —, então há um guard de versão logo no início do deploy: com um
node antigo, o job falha antes de montar a release em vez de queimar um deploy.

```bash
# Banco de lembretes
sudo ls -l /var/lib/luna-server/
```

## Operação

```bash
# Logs ao vivo
sudo journalctl -u luna-server -f

# Estado do serviço e release ativa
sudo systemctl status luna-server
ls -l /opt/luna/current

# Health check
curl -s "http://127.0.0.1:$WS_PORT/health"

# Trocar segredos (exige restart manual — deploy não recarrega o env sozinho)
sudo nano /etc/luna-server.env && sudo systemctl restart luna-server
```

### Rollback manual

```bash
ls -1dt /opt/luna/releases/*/          # releases disponíveis, mais recente primeiro
sudo -u <runner-user> ln -sfn /opt/luna/releases/<sha-antigo> /opt/luna/current.tmp
sudo -u <runner-user> mv -Tf /opt/luna/current.tmp /opt/luna/current
sudo systemctl restart luna-server
```

Reverter no Git (`git revert` + push na `main`) também funciona e é preferível,
já que mantém o servidor e o repositório em sincronia.
