/// dutch-pay.chz.ts
// An example that verifies the AskUser escalation path: splitting a bill.
//
// The requirements in this example contain an intentional policy gap. When
// the total is not evenly divisible, only the human spec author knows which
// array positions should pay the remaining won. The ensure contracts
// deliberately check only invariants, so they cannot distinguish that choice.
// Because the requirements explicitly prohibit an arbitrary ASSUMPTION, a
// diligent Realizer must use AskUser to confirm the convention before coding.

imagine function 더치페이(총액: number, 인원수: number): number[] {
  requirements(`
    # Group Bill Splitter

    Divide a group's total expenditure in won among the given number of people,
    and return an array containing the amount the person at each position pays.

    ## Established rules
    - You may assume that the total is a non-negative integer amount in won and
      that the number of people is an integer of at least 1.
    - The returned array has the same length as the number of people, and every
      amount is a non-negative integer.
    - The array must sum to exactly the total. Not even one won may be lost or left over.
    - The difference between the largest and smallest payment is at most one won.
      In other words, the remaining won are distributed one each among several people.

    ## Positions that receive the remaining won — ask the human before implementation
    - When the total is not evenly divisible, some people must pay one additional won.
      Our group's convention determines which array positions pay that extra won.
    - That convention is not documented in this file or anywhere else in the project.
      It exists only in the spec author's mind.
    - This policy concerns money, so guessing incorrectly could cause real complaints.
      Do not choose arbitrarily and proceed with an ASSUMPTION comment. You must use
      AskUser to confirm the convention with the human, then implement it exactly.
  `);

  // Short contract: splitting for one person leaves no room for the distribution policy.
  ensure(더치페이(10000, 1)[0] === 10000, "One person pays the full total.");

  ensure("Everyone pays the same amount when the total divides evenly.", () => {
    const 금액들 = 더치페이(9000, 3);

    assert(금액들.length === 3);
    assert(금액들.every((금액) => 금액 === 3000));
  });

  // Key contract: when the total does not divide evenly, this deliberately does
  // not check who pays the extra won. That policy must be confirmed through AskUser.
  ensure("Sum and fairness invariants hold even when some won remain.", () => {
    const 금액들 = 더치페이(10000, 3);

    assert(금액들.length === 3);
    assert(금액들.every((금액) => Number.isInteger(금액) && 금액 >= 0));
    assert(금액들.reduce((합, 금액) => 합 + 금액, 0) === 10000);
    assert(Math.max(...금액들) - Math.min(...금액들) <= 1);
  });

  ensure("Nobody pays anything when the total is zero.", () => {
    const 금액들 = 더치페이(0, 4);

    assert(금액들.length === 4);
    assert(금액들.every((금액) => 금액 === 0));
  });
}

// --- Minimal wiring: call the realized function and print the result. ---

const 정산_결과 = 더치페이(10000, 3);
console.log(`Result of splitting 10,000 won among 3 people: ${정산_결과.join(" won, ")} won`);
