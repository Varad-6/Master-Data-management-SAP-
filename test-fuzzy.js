// test-fuzzy.js - Standalone Interactive & Automated Fuzzy Matching Test Runner
const {
    normalizeText,
    levenshteinSimilarity,
    diceSimilarity,
    soundex,
    calculateHybridScore
} = require('./srv/lib/fuzzy-engine');

console.log("==========================================================================");
console.log("             🔍 ENTERPRISE FUZZY ENGINE TEST SUITE");
console.log("==========================================================================");

const testCases = [
    {
        category: "1. Corporate Legal Suffix Variations",
        inputA: "Tata Consultancy Services Ltd",
        inputB: "Tata Consultancy Services Pvt Ltd",
        expected: ">= 95% (Exact entity with different legal suffix)"
    },
    {
        category: "2. Typing Errors / Minor Typos",
        inputA: "Infosys Technologies",
        inputB: "Infosyss Techologies",
        expected: ">= 85% (Typo with repeated & missing letters)"
    },
    {
        category: "3. Short Name Letter Repeats",
        inputA: "Ram",
        inputB: "Raam",
        expected: ">= 85% (Single vowel stretch)"
    },
    {
        category: "4. Phonetic / Sound-alike Names (Soundex)",
        inputA: "Smyth & Wesson",
        inputB: "Smith and Wesson",
        expected: ">= 75% (Phonetic equivalence)"
    },
    {
        category: "5. Punctuation & Special Character Differences",
        inputA: "L&T Construction (India) Pvt. Ltd.",
        inputB: "L T Construction India Limited",
        expected: ">= 90% (Punctuation noise filtered)"
    },
    {
        category: "6. Completely Distinct Entities (Negative Control)",
        inputA: "Apple Inc.",
        inputB: "Microsoft Corporation",
        expected: "< 20% (Zero false positives)"
    },
    {
        category: "7. Profit Center / Material Master Descriptions",
        inputA: "STEEL PIPE 50MM SCH40",
        inputB: "STEEL PIPE 50 MM SCH 40",
        expected: ">= 95% (Spacing variation in materials)"
    }
];

testCases.forEach((tc, idx) => {
    const score = calculateHybridScore(tc.inputA, tc.inputB);
    const normA = normalizeText(tc.inputA);
    const normB = normalizeText(tc.inputB);
    const lev = Math.round(levenshteinSimilarity(normA, normB) * 100);
    const dice = Math.round(diceSimilarity(normA, normB) * 100);
    const codeA = soundex(normA);
    const codeB = soundex(normB);
    const phon = codeA === codeB ? 100 : 0;

    let statusBadge = "🟢 PASS";
    if (tc.expected.includes("<") && score >= 30) statusBadge = "🔴 FAIL";
    if (tc.expected.includes(">=") && score < 70) statusBadge = "🔴 FAIL";

    console.log(`\nTest #${idx + 1}: ${tc.category}`);
    console.log(`  Input A : "${tc.inputA}"`);
    console.log(`  Input B : "${tc.inputB}"`);
    console.log(`  Breakdown -> Levenshtein: ${lev}% | Sørensen-Dice: ${dice}% | Soundex: ${codeA} vs ${codeB} (${phon}%)`);
    console.log(`  🎯 Final Hybrid Score : ${score}%  [${statusBadge}]`);
    console.log(`  Expected: ${tc.expected}`);
});

console.log("\n==========================================================================");
console.log("💡 You can test any custom names by running:");
console.log("   node -e \"const { calculateHybridSimilarity } = require('./srv/lib/fuzzy-engine'); console.log(calculateHybridSimilarity('Name1', 'Name2') + '%');\"");
console.log("==========================================================================\n");
