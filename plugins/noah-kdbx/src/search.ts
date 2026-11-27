import { match } from "pinyin-pro";

const fieldAliases = {
  title: "title", 标题: "title", 標題: "title",
  user: "user", 用户名: "user", 使用者名稱: "user",
  url: "url", 网址: "url", 網址: "url",
  group: "group", 分组: "group", 分組: "group",
  tag: "tag", 标签: "tag", 標籤: "tag",
  vault: "vault", 密码库: "vault", 密碼庫: "vault",
  color: "color", 颜色: "color", 顏色: "color",
} as const;

type SearchField = (typeof fieldAliases)[keyof typeof fieldAliases];

function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/ς/g, "σ");
}

function foldLatin(text: string) {
  return text.normalize("NFD").replace(/(\p{Script=Latin})\p{Mark}+/gu, "$1").normalize("NFC");
}

const tokens = new RegExp(`(?:(${Object.keys(fieldAliases).join("|")}):)?(?:"([^"]*)"|“([^”]*)”|(\\S+))`, "gu");

export function searchTerms(query: string) {
  return [...normalize(query).matchAll(tokens)]
    .map(([, prefix, phrase, curvedPhrase, word]) => {
      const term = phrase ?? curvedPhrase ?? word;
      const folded = foldLatin(term);
      const pinyin = foldLatin(term.normalize("NFD").replace(/u\u0308/g, "v"));
      return {
        field: prefix ? fieldAliases[prefix as keyof typeof fieldAliases] : undefined,
        term,
        folded,
        pinyin: /^[a-z]+(?:\s+[a-z]+)*$/.test(pinyin) ? pinyin : undefined,
      };
    })
    .filter(({ term }) => term.length > 0);
}

export function matchesSearch(fields: Record<SearchField, string>, terms: ReturnType<typeof searchTerms>) {
  return terms.every(({ field, term, folded, pinyin }) => {
    const values = field ? [fields[field]] : Object.values(fields);
    return values.some((value) => {
      const text = normalize(value);
      return text.includes(term) || foldLatin(text).includes(folded)
        || Boolean(pinyin && /\p{Script=Han}/u.test(text) && match(text, pinyin, { continuous: true, v: true }));
    });
  });
}
