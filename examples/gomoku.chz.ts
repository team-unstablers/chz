imagine class GomokuGame {
    requirements(`
        # CLI 오목 게임

        - CLI로 플레이할 수 있는 오목 게임을 작성합니다.
        - 내 턴에서는 ←↓↑→ 키로 커서를 이동할 수 있습니다. 엔터 키로 돌을 놓을 자리를 확정합니다.
        - CPU의 알고리즘은 적당히 멍청해야 합니다.

        - 게임 도중 SIGINT로 종료하면, '비겁한 놈!' 이라는 메시지가 출력되어야 합니다.
    `);

    imagine async start() {}

    imagine async cleanup() {
        requirements(`이벤트 리스너 등을 정리합니다.`);
    }
}

const game = new GomokuGame();
await game.start();
