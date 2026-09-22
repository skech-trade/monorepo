import { expect, test } from "bun:test";
import { levelOf, scorePrediction, usernameOf } from "./social-rules";
test("usernames normalize and reject reserved or malformed claims",()=>{
  expect(usernameOf(" Alice_7 ")).toBe("alice_7");
  for(const x of ["admin","API","ab","7alice","a b","x".repeat(21),null])expect(usernameOf(x)).toBeNull();
});
test("levels are deterministic at their boundaries",()=>{
  expect(levelOf(99)).toEqual({level:1,nextLevelAt:100});
  expect(levelOf(100)).toEqual({level:2,nextLevelAt:250});
});
test("points use server candles, with no stake or leverage multiplier",()=>{
  const up=[{t:0,price:100},{t:1,price:110}];
  expect(scorePrediction(up,100,[{t:1,o:100,c:105},{t:1.5,o:105,c:110}])).toEqual({accuracy:1,points:30});
  expect(scorePrediction(up,100,[{t:1,o:100,c:95}])).toEqual({accuracy:0,points:20});
  expect(scorePrediction(up,100,[{t:1,o:100,c:100}])).toEqual({accuracy:0,points:20});
});
