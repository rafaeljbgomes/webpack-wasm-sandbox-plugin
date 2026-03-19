import * as fs from "fs";
import * as path from "path";

export function findAllDtsFiles(
  dir: string,
  fileList: string[] = [],
): string[] {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findAllDtsFiles(filePath, fileList);
    } else {
      if (file.endsWith(".d.ts")) {
        fileList.push(filePath);
      }
    }
  });

  return fileList;
}
