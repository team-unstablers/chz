# Cheese Contribution Language (치즈기여어)

'치즈기여어'는 바이브 코딩을 위한 언어로, 'LLM이 구현하고, 사람이 감독하기 위한 프로그래밍 언어'를 목표로 하고 있습니다.

## TypeScript의 슈퍼셋

'치즈기여어'는 TypeScript의 '슈퍼셋'으로 설계되었습니다. 여러분이 알고 있는 TypeScript 코드는 거의 전부 그대로 유효한 치즈기여어 코드입니다. 치즈기여어는 그 위에 'imagine' 같은 확장 키워드를 얹어, LLM이 구현해야 하는 부분을 명시할 수 있게 합니다.

## 예제

```typescript chz
/// example.chz.ts
// '치즈기여어'는 일반적인 TypeScript와 같습니다!
const a = 1;
const b = 2;

const c = a + b;

function greet(name: string): string {
  return `Hello, ${name}!`;
}

// 치즈기여어에는 'imagine' 이라는 특별한 키워드가 있습니다.
// 'imagine' 키워드가 붙은 함수는, 'realize' 단계에서 LLM이 함수를 구현해 줍니다!
imagine function greetLikePirate(name: string): string {
  // requirements()를 통해 함수의 요구사항을 명시할 수 있습니다.
  // 꼭 필요하진 않지만, 요구사항을 명시하면 LLM이 더 정확하게 구현할 수 있습니다.
  requirements(`해적 말투로 인사하는 함수를 작성하십시오.`);
  
  // ensure()를 통해 함수의 결과가 만족해야 하는 계약을 명시할 수 있습니다.
  // 함수를 전달하면 '기계 검증 계약'이 되며, realize 단계에서 LLM이 구현한 함수를 테스트하는 데 사용됩니다.
  ensure((args, retval) => {
    // 반환값이 "Ahoy, <name>!" 형식인지 확인합니다.
    return typeof retval === 'string' && retval.startsWith('Ahoy, ');
  });
  
  // 문자열을 전달하면 '자연어 계약'이 됩니다.
  // LLM은 자연어 계약을 반드시 테스트 코드로 변환하여 (autogen 테스트) 검증해야 합니다.
  ensure(`반환값은 반드시 "Ahoy, <name>!" 형식이어야 합니다.`);
}

// 'imagine' 키워드는, 함수 뿐만이 아니라 클래스에도 적용할 수 있습니다!
imagine class ShootingGame {
  requirements(`
    # Space Invaders-like 한 2D 슈팅 게임을 구현하십시오.
    
    ## 게임 규칙
    
    - 플레이어는 좌우로만 이동할 수 있어야 합니다.
    - 플레이어는 총알을 발사할 수 있어야 합니다.
    - 외계인 적은 오른쪽에서 왼쪽으로 이동하며, 화면에 끝에 도달하면 한줄씩 아래로 내려옵니다.
    
    ## 기술 스택
    
    - HTML5 Canvas를 사용하십시오.
    - 효과음 재생에는 Web Audio API를 사용하십시오.
    
    ## NOTE
    
    - HTML5 Canvas 내부에서 '게임 시작' 버튼을 클릭하면 게임이 시작되어야 합니다.
    - 60 FPS로 게임 루프를 구현해야 합니다.
  `);
  
  // imagine class 내부에서, 추가적으로 필요한 변수나 함수를 **정의**하거나 **요구**할 수 있습니다.
  // **정의하기**: 여기에 변수나 함수를 정의하면 LLM이 구현 시 참고할 수 있습니다.
  static collisionDetection2D(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number): boolean {
    return !(x1 + w1 < x2 || x2 + w2 < x1 || y1 + h1 < y2 || y2 + h2 < y1);
  }
  
  // **요구하기**: imagine 키워드를 사용하면 LLM에게 '이 함수/변수는 꼭 필요해요!' 하고 계약을 걸 수 있습니다.
  imagine var score: number {
    requirements(`게임 점수를 저장하는 변수가 필요합니다. 게임 오버인 경우 0으로 초기화되어야 합니다.`);
  }
  
  imagine function initialize(attachToSelector: string): void {
    requirements(`게임을 초기화하고, 지정된 CSS 선택자에 게임 캔버스를 붙이는 함수를 구현하십시오.`);
  }
  
  imagine function startGame(): void {
    requirements(`게임을 시작하는 함수를 구현하십시오. 게임 루프를 시작하고, 외계인 적을 화면에 나타나게 해야 합니다.`);
  }
  
  imagine function playSound(sound: Chz.AudioAsset): void {
    requirements(`주어진 오디오 자원을 재생하는 함수를 구현하십시오. Web Audio API를 사용해야 합니다.`);
  }
  
  // 'imagine resource' 키워드를 통해, 생성형 AI로부터 리소스를 요구할 수 있습니다.
  imagine resource background: Chz.ImageAsset {
    // 리소스 프로퍼티는 생성 파라미터인 동시에, 산출물에 대한 검증 조건으로도 사용됩니다.
    width = 720;
    height = 1280;
    
    requirements(`2D 슈팅 게임에 적합한 배경 이미지를 생성하십시오. 배경은 우주 공간을 연상시키는 디자인이어야 합니다.`);
  };
  
  imagine resource alienSprite: Chz.ImageAsset {
    width = 64;
    height = 64;
    
    requirements(`외계인 적 캐릭터 스프라이트를 생성하십시오. 외계인은 귀엽고 만화적인 스타일이어야 합니다.`);
  };
  
  imagine resource playerSprite: Chz.ImageAsset {
    width = 64;
    height = 64;
  
    requirements(`플레이어 캐릭터 스프라이트를 생성하십시오. 플레이어는 우주선 형태여야 합니다.`);
  };
  
  imagine resource bulletSprite: Chz.ImageAsset {
    width = 16;
    height = 16;
    
    requirements(`총알 스프라이트를 생성하십시오. 총알은 단순한 원형 모양이어야 합니다.`);
  };
  
  imagine resource shootSound: Chz.AudioAsset {
    // maxDuration 같은 제약 프로퍼티를 통해 상한/하한을 걸 수도 있습니다.
    maxDuration = 1.0;
    
    requirements(`총알 발사 효과음을 생성하십시오. 짧고 날카로운 소리여야 합니다.`);
  };
}

// imagine 함수는 평범한 함수처럼 호출할 수 있습니다.
console.log(greetLikePirate('치즈군'));
```

### 그러면, 이 코드는 어떻게 실행하나요?

'치즈기여어'는 TypeScript의 슈퍼셋이지만, 이 코드를 곧바로 실행할 수 있는 것은 아닙니다. 'imagine' 키워드가 붙은 함수나 클래스는 사람이 상상한 요구사항으로만 남아 있기 때문에, 이를 LLM이 '현실화' (realize) 해주는 과정을 거쳐야 합니다.

```shell
# 이 명령을 실행하면 'realize' 단계가 진행되며, imagine 키워드가 붙은 함수와 클래스가 LLM에 의해 구현됩니다.
$ chz realize example.chz.ts

# realize가 완료되면, 아래와 같은 파일 구조가 생성됩니다.
|- example.chz.ts
|- chz/realization
    |- example/
        |- realization-cache.json                # 증분 realize를 위한 캐시
        |- implementation.ts                     # 진입점 — prologue → 구현 → epilogue 순으로 연결합니다
        |- implementations/                      # 실제 구현이 들어 있는 디렉토리 
            |- __prologue__.ts                   # 사람이 작성한 코드 중 imagine 심볼을 참조하지 않는 부분 (a, b, c, greet)
            |- greetLikePirate.ts                # 실제 구현된 greetLikePirate 함수
            |- ShootingGame.ts                   # 실제 구현된 ShootingGame 클래스
            |- __epilogue__.ts                   # 사람이 작성한 코드 중 imagine 심볼을 참조하는 부분 (마지막의 console.log)
        |- tests/                                # 테스트 코드
            |- test_greetLikePirate.ensure.ts    # 사람이 작성한 ensure() 계약 테스트
            |- test_greetLikePirate.autogen.ts   # 구현 과정에서 LLM이 필요하다고 판단하여 자동 작성한 테스트
            |- test_ShootingGame.autogen.ts      # 구현 과정에서 LLM이 필요하다고 판단하여 자동 작성한 테스트
        |- resources/ 
            |- ShootingGame/
                |- background.png
                |- alienSprite.png
                |- playerSprite.png
                |- bulletSprite.png
                |- shootSound.ogg
```

사람이 직접 작성한 코드도 realization 디렉토리에 복사된다는 점에 주목하십시오.
`chz build`는 이 디렉토리만으로 — LLM 호출 없이 — 빌드를 수행해야 하기
때문입니다. 이때 imagine 심볼을 참조하지 않는 코드는 `__prologue__.ts`로,
참조하는 코드는 `__epilogue__.ts`로 나뉘어 저장됩니다. 구현보다 먼저 로드되어야
하는 코드와 나중에 로드되어야 하는 코드의 구분이며, 자세한 규칙은
[60 문서](60-realize-intro.ko.md)를 참조하십시오.

realize에 대한 자세한 명세는 60 문서에서 확인할 수 있습니다.

