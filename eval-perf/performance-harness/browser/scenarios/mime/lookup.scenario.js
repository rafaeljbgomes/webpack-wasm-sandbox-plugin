import mime from "mime";

const filenames = [
  "report.pdf",
  "index.html",
  "archive.tar.gz",
  "photo.jpeg",
  "data.json",
  "styles.css",
  "script.mjs",
  "font.woff2",
];

export default function run() {
  const contentTypes = filenames.map((filename) => mime.getType(filename));
  const extensions = [
    mime.getExtension("application/json"),
    mime.getExtension("text/html"),
    mime.getExtension("image/jpeg"),
  ];

  if (
    contentTypes[0] !== "application/pdf" ||
    contentTypes.includes(null) ||
    extensions[0] !== "json" ||
    extensions[1] !== "html" ||
    !["jpg", "jpeg"].includes(extensions[2])
  ) {
    throw new Error("MIME scenario produced invalid lookup output.");
  }
}
