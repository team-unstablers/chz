export type GomokuStone = "black" | "white";

export interface GomokuPosition {
    readonly row: number;
    readonly column: number;
}

imagine class GomokuGame {
    requirements(`
        # CLI 오목 게임

        - 15×15 보드에서 사람과 CPU가 대전하는 CLI 오목 게임을 작성합니다.
        - 사람은 흑돌로 먼저 두고, CPU는 백돌로 둡니다.
        - 가로, 세로, 두 대각선 중 한 방향으로 같은 돌이 5개 이상 연속되면 승리합니다.
          흑과 백에 같은 규칙을 적용하며, 삼삼·사사 등의 금수는 없습니다.
        - 보드가 가득 찰 때까지 승자가 없으면 무승부입니다.

        - 사람의 턴에는 ←↓↑→ 키로 보드 안의 커서를 이동하고, 엔터 키로 빈 칸에
          흑돌을 놓습니다. 이미 돌이 있거나 보드 밖인 위치에는 둘 수 없습니다.
        - CPU는 즉시 이길 수 있으면 그 수를 선택하고, 그렇지 않으면 사람의 다음 수
          승리를 막습니다. 그 밖의 상황에서는 빈 칸 중 아무 곳이나 선택해도 되며,
          두 수 이상을 내다보는 탐색은 요구하지 않습니다.
        - 매 수 이후 보드와 현재 상태를 출력하고, 승리 또는 무승부가 확정되면 결과를
          출력한 뒤 입력 처리를 종료합니다.

        - 게임 도중 SIGINT로 종료하면 정확히 '비겁한 놈!'이라는 메시지를 출력한 뒤
          cleanup()을 호출합니다.
        - process.stdin / process.stdout을 직접 사용하십시오. 외부 터미널 모듈은 사용하지 않습니다.
        - start()는 아래의 placeStone(), stoneAt(), winner(), chooseCpuMove()를 사용해
          게임을 진행해야 하며, 별도의 보드 상태나 중복된 승리 판정 로직을 만들지 않습니다.
    `);

    imagine placeStone(row: number, column: number, stone: GomokuStone): boolean {
        requirements(`
            지정한 칸이 보드 안의 빈 칸이면 돌을 놓고 true를 반환합니다.
            행과 열은 0부터 14까지의 정수입니다. 범위 밖, 정수가 아닌 좌표, 이미 돌이
            있는 칸에는 아무 변경도 하지 않고 false를 반환합니다.
        `);

        ensure("유효한 빈 칸에만 돌을 놓을 수 있습니다.", () => {
            const game = new GomokuGame();

            assert(game.placeStone(0, 0, "black") === true);
            assert(game.placeStone(0, 0, "white") === false);
            assert(game.placeStone(-1, 0, "white") === false);
            assert(game.placeStone(15, 0, "white") === false);
            assert(game.placeStone(0, 1.5, "white") === false);
            assert(game.stoneAt(0, 0) === "black");
        });
    }

    imagine stoneAt(row: number, column: number): GomokuStone | null {
        requirements(`
            지정한 칸의 돌을 반환합니다. 빈 칸이거나 좌표가 보드 밖이면 null을 반환하며,
            보드 상태를 변경하지 않습니다.
        `);

        ensure("빈 칸과 착수된 칸의 상태를 조회할 수 있습니다.", () => {
            const game = new GomokuGame();

            assert(game.stoneAt(7, 7) === null);
            assert(game.placeStone(7, 7, "white") === true);
            assert(game.stoneAt(7, 7) === "white");
            assert(game.stoneAt(15, 7) === null);
        });
    }

    imagine winner(): GomokuStone | null {
        requirements(`
            현재 보드에서 가로, 세로 또는 두 대각선으로 5개 이상 연속된 돌의 색을
            반환합니다. 승자가 없으면 null을 반환하며, 보드 상태를 변경하지 않습니다.
        `);

        ensure("연속된 돌 네 개만으로는 승리하지 않습니다.", () => {
            const game = new GomokuGame();

            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(4, column, "black"));
            }

            assert(game.winner() === null);
        });

        ensure("가로와 세로의 장목을 포함해 다섯 개 이상이면 승리합니다.", () => {
            const horizontal = new GomokuGame();
            const vertical = new GomokuGame();

            for (let index = 0; index < 5; index += 1) {
                assert(horizontal.placeStone(5, index + 2, "black"));
            }
            for (let index = 0; index < 6; index += 1) {
                assert(vertical.placeStone(index + 4, 9, "white"));
            }

            assert(horizontal.winner() === "black");
            assert(vertical.winner() === "white");
        });

        ensure("두 방향의 대각선 승리를 모두 판정합니다.", () => {
            const descending = new GomokuGame();
            const ascending = new GomokuGame();

            for (let index = 0; index < 5; index += 1) {
                assert(descending.placeStone(index + 2, index + 3, "black"));
                assert(ascending.placeStone(index + 6, 10 - index, "white"));
            }

            assert(descending.winner() === "black");
            assert(ascending.winner() === "white");
        });
    }

    imagine chooseCpuMove(): GomokuPosition | null {
        requirements(`
            현재 보드를 변경하지 않고 CPU가 둘 한 칸을 선택합니다. 이미 승자가 있거나
            빈 칸이 없으면 null을 반환합니다.

            백돌이 한 수로 이길 수 있는 빈 칸이 있으면 그중 하나를 우선 선택합니다.
            그렇지 않고 흑돌이 다음 한 수로 이길 수 있다면 그 승리 칸 중 하나를
            선택해 막습니다. 어느 경우도 아니면 보드 안의 빈 칸을 선택합니다.
        `);

        ensure("CPU가 반환한 일반 수는 보드 안의 빈 칸이며 보드를 변경하지 않습니다.", () => {
            const game = new GomokuGame();
            const move = game.chooseCpuMove();

            assert(move !== null);
            assert(Number.isInteger(move.row) && move.row >= 0 && move.row < 15);
            assert(Number.isInteger(move.column) && move.column >= 0 && move.column < 15);
            assert(game.stoneAt(move.row, move.column) === null);
        });

        ensure("CPU는 한 수로 이길 수 있으면 그 수를 선택합니다.", () => {
            const game = new GomokuGame();
            assert(game.placeStone(7, 2, "black"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(7, column, "white"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 7 && move.column === 7);
            assert(game.stoneAt(7, 7) === null);
        });

        ensure("즉시 이길 수 없다면 사람의 다음 수 승리를 막습니다.", () => {
            const game = new GomokuGame();
            assert(game.placeStone(8, 2, "white"));
            for (let column = 3; column < 7; column += 1) {
                assert(game.placeStone(8, column, "black"));
            }

            const move = game.chooseCpuMove();
            assert(move?.row === 8 && move.column === 7);
            assert(game.stoneAt(8, 7) === null);
        });
    }

    imagine async start(): Promise<void> {
        requirements(`
            터미널을 게임 모드로 설정하고 게임 루프를 시작합니다. 사람의 입력, CPU의 수,
            승리 및 무승부 판정은 클래스의 테스트 가능한 메서드들에 위임합니다.
            start()가 끝날 때에는 성공, 오류, SIGINT 여부와 관계없이 cleanup()을 호출합니다.
        `);
    }

    imagine async cleanup(): Promise<void> {
        requirements(`
            등록한 stdin 및 SIGINT 이벤트 리스너를 제거하고 stdin의 raw mode와 원래
            터미널 상태를 복원합니다. 여러 번 호출해도 안전해야 합니다.
        `);
    }
}

const game = new GomokuGame();
await game.start();
