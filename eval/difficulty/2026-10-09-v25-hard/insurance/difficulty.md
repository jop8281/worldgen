# Difficulty: v25-hard-insurance

Models: claude-haiku-5-5. Episodes per task per model: 3, each with a $0.5 budget.

Charged $0.052387 of the $3 budget over 6 episodes. An episode with a call of unknown billing is charged its whole budget; there were 0 such calls.

Stop: complete.

A pass is an engine score of 1. A trial is a graded episode that stopped done or at its turn, budget or time limit; a model error, a refusal, a world or grade error and an interruption are not trials. The interval is Wilson 95%. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more, and hard below.

The engine score certifies the final world state only. It does not independently certify that the final reply is factually correct.

## By task

| world | task | labeled | measured | agrees | passes / trials | pass rate | 95% interval |
|---|---|---|---|---|---|---|---|
| gen-insurance | review_holder_claims | hard | easy | no | 3 / 3 | 1 | 0.439 to 1 |
| gen-insurance | find_and_confirm_fraud | hard | easy | no | 3 / 3 | 1 | 0.439 to 1 |

## By task and model

| world | task | labeled | model | measured | passes / trials | pass rate | 95% interval | episodes | stops | cost USD | USD per pass |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gen-insurance | review_holder_claims | hard | claude-haiku-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.041757 | 0.013919 |
| gen-insurance | find_and_confirm_fraud | hard | claude-haiku-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.010629 | 0.003543 |
