export const flows = [
  {
    id: "tarot-001",
    name: "3択タロットDM",
    marker: "[auto:tarot-001]",
    enabled: true,
    choices: {
      "1": {
        publicReplies: [
          "1ですね。鑑定結果をDMに送りました。",
          "1を選びましたね。DMに結果を送っています。",
          "1番ですね。カードからのメッセージをDMでお届けしました。"
        ],
        privateReply:
          "1を選んだあなたへ\n\n今回のカードは「星」です。\n\n今は、少しずつ希望が戻ってくるタイミング。無理に答えを出すより、心が軽くなる選択をひとつだけ選んでみてください。"
      },
      "2": {
        publicReplies: [
          "2ですね。鑑定結果をDMに送りました。",
          "2を選びましたね。DMに結果を送っています。",
          "2番ですね。カードからのメッセージをDMでお届けしました。"
        ],
        privateReply:
          "2を選んだあなたへ\n\n今回のカードは「月」です。\n\n今は、見えない不安に引っ張られやすい時期。でも直感は鈍っていません。焦って決めず、違和感のあるものから少し距離を置いてみてください。"
      },
      "3": {
        publicReplies: [
          "3ですね。鑑定結果をDMに送りました。",
          "3を選びましたね。DMに結果を送っています。",
          "3番ですね。カードからのメッセージをDMでお届けしました。"
        ],
        privateReply:
          "3を選んだあなたへ\n\n今回のカードは「太陽」です。\n\n近いうちに、気持ちが前向きになるきっかけが入りそうです。遠慮していたことほど、素直に出してみると流れが変わります。"
      }
    }
  }
];

export function findFlow(caption = "") {
  return flows.find((flow) => caption.includes(flow.marker));
}

export function normalizeChoices(choices = {}) {
  return Object.fromEntries(
    Object.entries(choices).map(([choice, reply]) => [
      choice,
      {
        publicReplies: normalizePublicReplies(reply),
        privateReply: reply?.privateReply ?? ""
      }
    ])
  );
}

export function normalizePublicReplies(reply = {}) {
  if (Array.isArray(reply.publicReplies)) {
    const replies = reply.publicReplies.map((item) => String(item).trim()).filter(Boolean);
    if (replies.length > 0) return replies;
  }

  if (reply.publicReply) return [String(reply.publicReply).trim()].filter(Boolean);
  return [];
}

export function parseChoice(text = "") {
  const normalized = text
    .replace(/[１２３]/g, (char) => String("１２３".indexOf(char) + 1))
    .replace(/[①➀❶]/g, "1")
    .replace(/[②➁❷]/g, "2")
    .replace(/[③➂❸]/g, "3")
    .trim()
    .toLowerCase();

  const match = normalized.match(/^(?:カード\s*)?([123])\s*(?:番|ばん)?$/);
  return match ? match[1] : null;
}
