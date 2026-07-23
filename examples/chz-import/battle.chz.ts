/// battle.chz.ts
// 치즈 파일이 다른 치즈 파일을 import하는 예 — 데미지 계산.
//
// 다른 치즈 모듈을 쓸 때도 규칙은 순수 TypeScript와 같습니다: 소스
// (`./stats.chz.ts`)를 직접 import하지 않고, realize가 생성하는 shim
// (`./stats`)을 import합니다(20 문서). 아래 import 문은 의존성 그래프가
// 파일 경계를 넘는 엣지를 발견하는 단서가 되며(62 문서), realize는
// `크리티컬_판정`을 먼저 완성한 뒤 이 파일을 진행합니다.

import { 크리티컬_판정, type CombatStats } from "./stats";

export imagine function 데미지_계산(
  attacker: CombatStats,
  defender: CombatStats,
): number {
  requirements(`
    # 공격자와 방어자의 스탯을 기반으로 최종 데미지를 계산하십시오.
    - 기본 데미지는 공격자의 attack에서 방어자의 defense를 고려하여
      산출하되, 구체적인 산식은 자유롭게 정하십시오.
    - 크리티컬 여부는 \`크리티컬_판정\`을 사용하여 판정하고, 크리티컬이면
      최종 데미지를 2배로 적용하십시오.
    - 최종 데미지는 음이 아닌 정수여야 합니다.
  `);

  ensure("최종 데미지는 음이 아닌 정수입니다.", () => {
    const damage = 데미지_계산(
      { attack: 10, defense: 5, luck: 0 },
      { attack: 5, defense: 5, luck: 0 },
    );
    assert(Number.isInteger(damage));
    assert(damage >= 0);
  });

  ensure("luck 100(항상 크리티컬)은 luck 0보다 데미지가 작지 않습니다.", () => {
    const 방어자: CombatStats = { attack: 5, defense: 5, luck: 0 };
    const 일반 = 데미지_계산({ attack: 10, defense: 5, luck: 0 }, 방어자);
    const 크리티컬 = 데미지_계산({ attack: 10, defense: 5, luck: 100 }, 방어자);
    assert(크리티컬 >= 일반);
  });
}
