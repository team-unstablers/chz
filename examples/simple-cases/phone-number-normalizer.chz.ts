imagine function phoneNumberNormalizer(input: string) {
    requirements(`
        # Mobile Phone Number Normalizer

        - Normalize 01012341234 to the 010-1234-1234 format.
        - Follow South Korean mobile phone number conventions.
        - Support both 010-123-1234 and 010-1234-1234.

        - Do not format invalid numbers. (010-1234-12345 -> invalid)
    `);
}

console.log(phoneNumberNormalizer("01012349999"));
console.log(phoneNumberNormalizer("0101239999"));
console.log(phoneNumberNormalizer("01012399991239812"));
