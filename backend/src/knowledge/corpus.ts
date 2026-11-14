import { createHash } from "node:crypto";

export const FIXED_CORPUS_NAME = "forcare-homecare-basics";
export const FIXED_CORPUS_VERSION = 1;
export const FIXED_CORPUS_OWNER = "ForCare — team-authored general education, not individual clinical orders";

const documents = [
  {
    title: "Mencegah jatuh / Preventing falls", version: 1,
    publisher: "World Health Organization", sourceTitle: "Falls",
    sourceUrl: "https://www.who.int/news-room/fact-sheets/detail/falls", accessedAt: "2026-11-14",
    chunks: [
      "Edukasi umum: Pencegahan jatuh di rumah mencakup lingkungan yang aman. Rapikan benda yang menghalangi jalan, perhatikan pencahayaan, dan kenali bahaya di sekitar rumah. Bahas kebutuhan dukungan dengan perawat. Ini bukan penilaian risiko atau instruksi perawatan untuk seseorang.\nGeneral education: Preventing falls includes a safer home environment. Keep walking paths clear, consider lighting, and recognize hazards at home. Discuss support needs with a nurse. This is not an individual risk assessment or treatment order.",
    ],
  },
  {
    title: "Kebersihan tangan / Handwashing", version: 1,
    publisher: "Centers for Disease Control and Prevention", sourceTitle: "About Handwashing",
    sourceUrl: "https://www.cdc.gov/clean-hands/about/index.html", accessedAt: "2026-11-14",
    chunks: [
      "Edukasi umum: Cuci tangan dengan sabun dan air membantu mengurangi penyebaran kuman. Bersihkan seluruh permukaan tangan, bilas, lalu keringkan. Kebersihan tangan penting sebelum menyiapkan atau makan makanan serta setelah menggunakan toilet. Ini edukasi umum, bukan resep atau instruksi perawatan individu.\nGeneral education: Handwashing with soap and water helps reduce the spread of germs. Clean all hand surfaces, rinse, and dry. Hand hygiene matters before preparing or eating food and after using the toilet. This is general education, not a prescription or individual care order.",
    ],
  },
] as const;

export function knowledgeChecksum(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

// Provenance is part of the immutable body/checksum. These are original short
// paraphrases, not publisher text; no network or operator-supplied content.
export const FIXED_KNOWLEDGE_DOCUMENTS = Object.freeze(documents.map((document) => {
  const body = `${document.title}\nPublisher: ${document.publisher}\nSource title: ${document.sourceTitle}\nSource URL: ${document.sourceUrl}\nAccess date: ${document.accessedAt}\nVersion: ${document.version}\nForCare team-authored paraphrase; general education only.\n\n${document.chunks.join("\n\n")}`;
  return Object.freeze({ ...document, chunks: Object.freeze([...document.chunks]), body, checksum: knowledgeChecksum(body) });
}));
