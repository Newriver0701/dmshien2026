export const flows = [
  {
    id: "tarot-001",
    name: "3択タロットDM",
    marker: "[auto:tarot-001]",
    enabled: true,
    choices: {
      "1": {
        publicReply: "1ですね。鑑定結果をDMに送りました。",
        privateReply:
          "1を選んだあなたへ\n\n今回のカードは「星」です。\n\n今は、少しずつ希望が戻ってくるタイミング。無理に答えを出すより、心が軽くなる選択をひとつだけ選んでみてください。"
      },
      "2": {
        publicReply: "2ですね。鑑定結果をDMに送りました。",
        privateReply:
          "2を選んだあなたへ\n\n今回のカードは「月」です。\n\n今は、見えない不安に引っ張られやすい時期。でも直感は鈍っていません。焦って決めず、違和感のあるものから少し距離を置いてみてください。"
      },
      "3": {
        publicReply: "3ですね。鑑定結果をDMに送りました。",
        privateReply:
          "3を選んだあなたへ\n\n今回のカードは「太陽」です。\n\n近いうちに、気持ちが前向きになるきっかけが入りそうです。遠慮していたことほど、素直に出してみると流れが変わります。"
      }
    }
  }
];

export function findFlow(caption = "") {
  return flows.find((flow) => caption.includes(flow.marker));
}

export function parseChoice(text = "") {
  const normalized = text
    .replace(/[１２３]/g, (char) => String("１２３".indexOf(char) + 1))
    .trim()
    .toLowerCase();

  const match = normalized.match(/^(?:カード\s*)?([123])\s*(?:番|ばん)?$/);
  return match ? match[1] : null;
}
