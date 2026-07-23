/// stats.chz.ts
// 크로스 파일 import 예제의 기반 모듈 — 전투 스탯과 크리티컬 판정.
//
// 이 파일이 `export`한 심볼은, `chz realize`가 소스 옆에 생성하는 shim
// (`stats.ts`)을 통해 다른 파일에서 import됩니다(20 문서). 사람이 작성한
// 타입·함수든 imagine 심볼이든 마찬가지로 shim을 거쳐 그대로 보입니다.

/** 전투에 참여하는 캐릭터의 스탯. */
export interface CombatStats {
  attack: number;
  defense: number;
  /** 행운. 0~100 범위이며, 크리티컬 확률에 영향을 줍니다. */
  luck: number;
}

/** 아무 보정도 없는 기본 스탯을 반환합니다. (사람이 직접 작성한 함수) */
export function 기본_스탯(): CombatStats {
  return { attack: 10, defense: 5, luck: 0 };
}

export imagine function 크리티컬_판정(attacker: CombatStats): boolean {
  requirements(`
    # 공격자의 스탯을 기반으로 이번 공격이 크리티컬인지 판정하십시오.
    - attacker.luck(0~100)이 높을수록 크리티컬 확률이 높아야 합니다.
    - luck이 0이면 크리티컬은 발생하지 않습니다.
    - luck이 100이면 항상 크리티컬이 발생합니다.
  `);

  ensure(
    typeof 크리티컬_판정({ attack: 10, defense: 5, luck: 50 }) === "boolean",
    "크리티컬 판정은 boolean을 반환합니다.",
  );

  ensure("luck 0은 크리티컬이 발생하지 않고, luck 100은 항상 발생합니다.", () => {
    assert(크리티컬_판정({ attack: 10, defense: 5, luck: 0 }) === false);
    assert(크리티컬_판정({ attack: 10, defense: 5, luck: 100 }) === true);
  });
}
