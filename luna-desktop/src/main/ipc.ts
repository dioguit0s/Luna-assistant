// Nomes dos canais IPC entre a janela oculta (renderer) e o processo
// principal. Importado tanto por preload.ts quanto por window.ts — mudar um
// nome aqui já corrige os dois lados, em vez de precisar sincronizar strings
// soltas (mesma razão de existir do protocol.ts compartilhado).

/** renderer → main: ArrayBuffer de PCM16 mono, 640 bytes (20ms), enviado continuamente enquanto a captura está ativa. */
export const IPC_MIC_FRAME = 'luna:mic-frame';

/** main → renderer: ArrayBuffer de PCM16 mono para tocar (chunk de audio_response). */
export const IPC_PLAY_PCM = 'luna:play-pcm';

/** main → renderer: para tudo que está tocando e limpa a fila — barge-in (forceListen) ou watchdog. */
export const IPC_FLUSH_PLAYBACK = 'luna:flush-playback';

/** renderer → main: getUserMedia ou addModule do worklet falhou. Payload: string. */
export const IPC_CAPTURE_ERROR = 'luna:capture-error';

/** renderer → main: captura inicializada com sucesso (mic + worklet prontos). */
export const IPC_CAPTURE_READY = 'luna:capture-ready';
