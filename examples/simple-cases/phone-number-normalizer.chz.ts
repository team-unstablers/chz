imagine function phoneNumberNormalizer(input: string) {
    requirements(`
        # 휴대폰 번호 노멀라이저

        - 01012341234 -> 010-1234-1234 형식으로 노멀라이즈 합니다.
        - 한국 휴대폰번호 기준.
        - 010-123-1234 / 010-1234-1234 의 두가지 형식이 있습니다

        - 무효한 번호는 포매팅 하지 마세요. (010-1234-12345 -> X)
    `);
}

console.log(phoneNumberNormalizer("01012349999"));
console.log(phoneNumberNormalizer("0101239999"));
console.log(phoneNumberNormalizer("01012399991239812"));
