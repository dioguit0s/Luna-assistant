#pragma once
#include <Arduino.h>

// Atualização de firmware pela rede (OTA), puxada pelo satélite. Ver ADR 012 e
// docs/protocolo-websocket.md (ota_start / ota_progress / ota_result).
//
// Fluxo:
//   1. O servidor manda `ota_start { url, version, sha256, size }`. A URL é do
//      PRÓPRIO servidor, na LAN, de uso único: o satélite nunca fala com a
//      internet nem com o TLS do GitHub.
//   2. start() abre uma task que baixa por HTTP e grava na partição OTA livre
//      (app0/app1 de 6,5 MB, default_16MB.csv), calculando o SHA-256 no
//      caminho. Tamanho e SHA-256 são conferidos contra o manifest ANTES de
//      trocar a partição de boot; não conferiu, a imagem é abandonada e o
//      satélite segue na versão atual.
//   3. Gravou e conferiu: troca a partição de boot e o loop() reinicia.
//
// Rollback automático (bootloader com CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, já
// ligado no core Arduino): a imagem nova nasce "pendente de verificação" e só é
// marcada válida em onAuthenticated() — depois de conectar e autenticar no
// servidor. Se não autenticar em OTA_VALIDATE_TIMEOUT_MS, loop() a marca
// inválida e reinicia na anterior. Se reiniciar antes disso (crash, boot loop,
// brownout), o próprio bootloader volta para a anterior.
namespace OtaUpdater {

// Lê o estado da imagem em execução. Chamar cedo no setup().
void beginBoot();

// Chamar a cada auth_ok: valida a imagem nova (cancela o rollback).
void onAuthenticated();

// Prazo de validação da imagem nova. Chamar no loop principal.
void loop();

// A imagem em execução ainda não foi validada (primeiro boot depois de OTA).
bool pendingVerify();

// Abre a OTA. nullptr = aceita (a task começou); senão, o motivo da recusa,
// que vai no ota_result. Não checa se o satélite está ocupado: isso é do main.
const char *start(const char *url, const char *version, const char *sha256Hex, uint32_t size);

// OTA aceita e ainda não encerrada (inclui "gravada, esperando reiniciar").
// Enquanto verdadeiro: wake word desligada, captura sem efeito, LED "atualizando".
bool active();

// 0..100 do download/gravação.
int progress();

// A task terminou e o resultado ainda não foi consumido.
bool finished();
uint32_t finishedAtMs();

// Consome o resultado. ok=true: a partição de boot já foi trocada e o chamador
// deve reiniciar (active() continua verdadeiro até lá). ok=false: a imagem foi
// abandonada, `error` diz por quê, e active() volta a falso.
bool takeResult(bool &ok, String &error);

} // namespace OtaUpdater
