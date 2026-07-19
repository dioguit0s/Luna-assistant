import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLunaSystemPrompt } from './luna-system-prompt.js';
import type { ConversationTurn } from '../providers/types.js';

const at = (hour: number, minute = 0): Date => new Date(2026, 6, 19, hour, minute, 0);

describe('buildLunaSystemPrompt', () => {
  it('traduz room_id conhecido para nome legível', () => {
    const prompt = buildLunaSystemPrompt('cozinha', [], at(10));
    assert.match(prompt, /dispositivo em a cozinha/);
  });

  it('traduz os três area_id do Home Assistant', () => {
    // Regressão: as chaves precisam ser o `area_id` exato do HA (`sala_de_estar`,
    // não `sala`), senão o cômodo cai no fallback genérico. Ver infra/README.md.
    assert.match(buildLunaSystemPrompt('sala_de_estar', [], at(10)), /em a sala de estar/);
    assert.match(buildLunaSystemPrompt('cozinha', [], at(10)), /em a cozinha/);
    assert.match(buildLunaSystemPrompt('quarto', [], at(10)), /em o quarto/);
  });

  it('usa fallback citado para room_id desconhecido', () => {
    const prompt = buildLunaSystemPrompt('varanda', [], at(10));
    assert.match(prompt, /o ambiente "varanda"/);
  });

  it('classifica o período do dia por faixa horária', () => {
    const casos: Array<[number, string]> = [
      [2, 'madrugada'],
      [4, 'madrugada'],
      [5, 'manhã'],
      [11, 'manhã'],
      [12, 'tarde'],
      [17, 'tarde'],
      [18, 'noite'],
      [23, 'noite'],
    ];

    for (const [hora, periodo] of casos) {
      const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(hora));
      assert.match(
        prompt,
        new RegExp(`período da ${periodo}`),
        `hora ${hora} deveria ser ${periodo}`,
      );
    }
  });

  it('formata a hora com zero à esquerda', () => {
    assert.match(buildLunaSystemPrompt('sala_de_estar', [], at(7, 5)), /Agora são 07:05/);
    assert.match(buildLunaSystemPrompt('sala_de_estar', [], at(19, 30)), /Agora são 19:30/);
  });

  it('sinaliza ausência de histórico na primeira fala', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /Ainda não há histórico/);
    assert.doesNotMatch(prompt, /Histórico recente desta conversa/);
  });

  it('renderiza histórico com rótulos Usuário/Luna', () => {
    const history: ConversationTurn[] = [
      { role: 'user', text: 'acende a luz', timestamp: 1 },
      { role: 'assistant', text: 'Pronto.', timestamp: 2 },
    ];
    const prompt = buildLunaSystemPrompt('sala_de_estar', history, at(10));

    assert.match(prompt, /Histórico recente desta conversa/);
    assert.match(prompt, /Usuário: acende a luz/);
    assert.match(prompt, /Luna: Pronto\./);
    assert.doesNotMatch(prompt, /Ainda não há histórico/);
  });

  it('mantém as diretrizes de fala para TTS', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /Nunca use markdown/);
    assert.match(prompt, /vinte e três graus/);
    assert.match(prompt, /Nunca mencione IA/);
  });

  it('descreve a tool control_device e quando não usá-la', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /# Automação da casa/);
    assert.match(prompt, /control_device/);
    assert.match(prompt, /não é comando/);
  });

  it('manda preencher room_id com o area_id cru da sessão', () => {
    // O rótulo falável ("a cozinha") não serve como argumento: o `room_id` precisa
    // ser o `area_id` do HA. Os dois têm que aparecer, cada um no seu papel.
    const prompt = buildLunaSystemPrompt('cozinha', [], at(10));
    assert.match(prompt, /preencha room_id com "cozinha"/);
    assert.match(prompt, /sempre daqui, a cozinha/);
  });

  it('pede confirmação curta no passado após sucesso', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /confirme curto e no passado/);
    assert.match(prompt, /Nunca narre o que você vai fazer/);
  });

  it('orienta fala natural para aparelho desconhecido e casa fora do ar', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /Aparelho que não existe ou não está neste cômodo/);
    assert.match(prompt, /A casa não respondeu/);
    assert.match(prompt, /Nunca diga que ligou ou desligou algo sem ter recebido a confirmação/);
  });

  it('inclui os exemplos few-shot de estilo', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    assert.match(prompt, /# Exemplos de estilo/);
    assert.match(prompt, /Luna: Não peguei direito/);
  });

  it('não vaza marcação markdown nos exemplos de fala da Luna', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', [], at(10));
    const falasDaLuna = prompt
      .split('\n')
      .filter((linha) => linha.startsWith('Luna: '))
      .map((linha) => linha.slice('Luna: '.length));

    assert.ok(falasDaLuna.length >= 5, 'esperava vários exemplos de fala');
    for (const fala of falasDaLuna) {
      assert.doesNotMatch(fala, /[*_#`]/, `exemplo com markdown: ${fala}`);
      assert.doesNotMatch(fala, /\d/, `exemplo com número em dígito: ${fala}`);
    }
  });

  it('usa a hora atual quando o parâmetro now é omitido', () => {
    const prompt = buildLunaSystemPrompt('sala_de_estar', []);
    assert.match(prompt, /Agora são \d{2}:\d{2}/);
  });
});
