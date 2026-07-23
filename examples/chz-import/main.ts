/// main.ts
// 순수 TypeScript 파일이 치즈 모듈을 사용하는 예 — 치즈 문법이 전혀 없습니다.
//
// import 경로는 소스(.chz.ts)가 아니라 realize가 생성·커밋하는 shim
// (`./stats`, `./battle`)을 가리킵니다. shim은 커밋된 평범한 .ts 파일이므로
// 이 파일은 번들러 플러그인이나 치즈 전용 빌드 단계 없이, 어떤 도구에서든
// 표준 해석 규칙만으로 동작합니다(20 문서).
//
// 단, 아직 한 번도 realize하지 않았다면 shim이 존재하지 않으므로 아래
// import는 타입 에러가 됩니다. 이는 문서화된 공백입니다(20 문서 NOTE 참조).

import { 기본_스탯, type CombatStats } from "./stats";
import { 데미지_계산 } from "./battle";

const 공격자: CombatStats = { ...기본_스탯(), attack: 12, luck: 80 };
const 방어자: CombatStats = 기본_스탯();

const 데미지 = 데미지_계산(공격자, 방어자);
console.log(`이번 공격의 데미지: ${데미지}`);
