import { describe, expect, it } from "vitest";
import { parseConnectStream } from "../src/orb/envd.js";

describe("parseConnectStream", () => {
  it("folds event.data and event.end frames", () => {
    const body =
        '{"event":{"data":{"stdout":"hello"}}}' +
        '{"event":{"end":{"exitCode":0}}}';
    expect(parseConnectStream(body)).toEqual({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    });
  });

  it("reads ConnectRPC result-wrapped frames", () => {
    const body =
        '{"result":{"event":{"data":{"stdout":"out","stderr":"err"}}}}' +
        '{"result":{"event":{"end":{"exitCode":2}}}}';
    expect(parseConnectStream(body)).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 2,
    });
  });

  it("skips objects that are not envd frames", () => {
    expect(parseConnectStream('{"unrelated":true}{"event":{"end":{"exitCode":1}}}'))
        .toEqual({ stdout: "", stderr: "", exitCode: 1 });
  });
});
