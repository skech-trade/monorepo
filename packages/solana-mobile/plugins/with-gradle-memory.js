/*
  Gives Gradle room for a full release build: with expo-updates' native code the default 512 MB of metaspace runs
  out on a clean build. android/ is generated, so the setting lives here.
*/
const { withGradleProperties } = require("expo/config-plugins");

const ARGS = "-Xmx4g -XX:MaxMetaspaceSize=1536m";

module.exports = (config) =>
  withGradleProperties(config, (c) => {
    const p = c.modResults.find((i) => i.type === "property" && i.key === "org.gradle.jvmargs");
    if (p) p.value = ARGS;
    else c.modResults.push({ type: "property", key: "org.gradle.jvmargs", value: ARGS });
    return c;
  });
