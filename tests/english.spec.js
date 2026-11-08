import { test, expect } from "@playwright/test";
import { englishPhonemes } from "../english.js";
import { joinWrappedEnglishLines } from "../transcript.js";

for (const accent of ["a", "b"]) {
  test(`English ${accent}: amounts and quantities are not mistaken for years`, async () => {
    const read = (text) => englishPhonemes(text, accent);
    for (const amount of ["1234", "2024", "1234.56", "2024.50"])
      expect(await read(`It costs $${amount}.`)).toBe(
        await read(`It costs $${amount[0]},${amount.slice(1)}.`));
    // British number readings include a reduced "and". Verify the full numeral
    // sequence rather than demanding the American phrasing for both accents.
    const amount = accent === "a"
      ? "wˈʌn θˈaʊzənd tˈuː hˈʌndɹɪd θˈɜːɾi fˈoːɹ"
      : "wˈɒn θˈaʊzənd tˈuː hˈʌndɹɪdən θˈɜːti fˈɔː";
    expect(await read("It costs $1234.")).toContain(amount);
    const pounds = await read("It costs £1234.56.");
    expect(pounds).toContain(amount);
    expect(pounds).toContain("fˈɪfti sˈɪks");
    expect(await read("I have 2024 books.")).toContain(accent === "a"
      ? "tˈuː θˈaʊzənd twˈɛnti fˈoːɹ" : "tˈuː θˈaʊzənd ən twˈɛnti fˈɔː");
    expect(await read("We met in 2024.")).toBe(await read("We met in twenty twenty four."));
    expect(await read("It costs $3.50.")).toBe(await read("It costs three dollars and fifty cents."));
    expect(await read("The value is 3.14.")).toBe(await read("The value is three point one four."));
  });

  test(`English ${accent}: clear past read changes without rewriting present or future`, async () => {
    for (const text of ["I read that book yesterday.", "Yesterday, I read a book.",
      "Last night she read a story.", "We read it last week."])
      expect(await englishPhonemes(text, accent)).toContain("ɹˈɛd");
    for (const text of ["I read books every day.", "I will read it tomorrow.",
      "Yesterday I decided to read the book.", "I read yesterday's news every morning."])
      expect(await englishPhonemes(text, accent)).toContain("ɹˈiːd");
    expect(await englishPhonemes("I have read it.", accent)).toContain("ɹˈɛd");
    // Different occurrences in one sentence must not be globally replaced.
    const both = await englishPhonemes("Yesterday I read it, but I will read it again.", accent);
    expect(both).toContain("ɹˈɛd");
    expect(both).toContain("ɹˈiːd");
  });

  test(`English ${accent}: record has verb stress in clear requests, noun stress stays`, async () => {
    const verb = accent === "a" ? "ɹᵻkˈoːɹd" : "ɹɪkˈɔːd";
    const noun = accent === "a" ? "ɹˈɛkɚd" : "ɹˈɛkɔːd";
    for (const text of ["Please record a message.", "Record the lesson.", "I want to record it."])
      expect(await englishPhonemes(text, accent)).toContain(verb);
    for (const text of ["This is a record.", "Record sales increased.", "For the record, I agree."])
      expect(await englishPhonemes(text, accent)).toContain(noun);
    const both = await englishPhonemes("Please record the record.", accent);
    expect(both).toContain(verb);
    expect(both).toContain(noun);
  });
}

test("explicit English wrap cleanup keeps intentional boundaries", () => {
  expect(joinWrappedEnglishLines("I want to learn\nhow to speak\nEnglish naturally.")).toBe(
    "I want to learn how to speak English naturally.");
  expect(joinWrappedEnglishLines("I want to learn\r\nhow to speak.")).toBe("I want to learn how to speak.");
  for (const text of ["First sentence.\nSecond sentence.", "First question?\nYes!",
    'He said "Hello."\nThen left.', "First paragraph\n\nSecond paragraph",
    "- first item\n- second item", "1. first item\n2. second item",
    "A: hello\nB: hello", "A: hello\ncontinued dialogue", "lan-\nguage",
    "你好\n一起练习", "First:\nExplanation"])
    expect(joinWrappedEnglishLines(text)).toBe(text);
});
