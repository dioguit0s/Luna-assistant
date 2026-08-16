---
description: Revisa as alterações de código pendentes com o agente luna-code-reviewer
---

Despache o agente `luna-code-reviewer` para revisar as alterações de código.

Escopo: $ARGUMENTS

Se nenhum escopo foi passado acima, revise as alterações pendentes no working tree (`git diff` e `git diff --staged`); se não houver nenhuma, revise o último commit. Se um escopo foi passado — um caminho, um commit, um intervalo como `HEAD~3..HEAD` — repasse-o ao agente e peça que ele se limite a isso.

Apresente os achados do agente na íntegra, na ordem de severidade em que vieram. Não aplique correções sem que o usuário peça.
