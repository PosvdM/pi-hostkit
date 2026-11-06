{
  "targets": [
    {
      "target_name": "hostkit",
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/native/hostkit_win.c"],
          "libraries": ["advapi32.lib"],
          "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"]
        }],
        ["OS!='win'", {
          "sources": ["src/native/hostkit_posix.c"],
          "cflags": ["-Wall", "-Wextra"],
          "xcode_settings": { "WARNING_CFLAGS": ["-Wall", "-Wextra"] }
        }]
      ]
    }
  ]
}
