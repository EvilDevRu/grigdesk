// Схема v1 совпадает с mobileContract.schema.json; новые поля остаются необязательными.
export const mobileSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:cockpit:mobile:v1",
  "title": "Мобильный контракт Кокпита v1",
  "$defs": {
    "hello": {
      "type": "object",
      "required": [
        "api",
        "minApp",
        "serverTime",
        "server",
        "device"
      ],
      "properties": {
        "api": {
          "enum": [
            1
          ]
        },
        "minApp": {
          "type": "string",
          "maxLength": 40
        },
        "serverTime": {
          "type": "integer",
          "minimum": 0
        },
        "server": {
          "type": "object",
          "required": [
            "name",
            "version"
          ],
          "properties": {
            "name": {
              "type": "string",
              "maxLength": 80
            },
            "version": {
              "type": "string",
              "maxLength": 40
            }
          },
          "additionalProperties": true
        },
        "device": {
          "anyOf": [
            {
              "type": "object",
              "required": [
                "id",
                "name"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "maxLength": 128
                },
                "name": {
                  "type": "string",
                  "maxLength": 80
                }
              },
              "additionalProperties": true
            },
            {
              "type": "null"
            }
          ]
        },
        "features": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string",
            "maxLength": 100
          }
        }
      },
      "additionalProperties": true
    },
    "pair": {
      "type": "object",
      "required": [
        "device"
      ],
      "properties": {
        "device": {
          "type": "object",
          "required": [
            "id",
            "name"
          ],
          "properties": {
            "id": {
              "type": "string",
              "maxLength": 128
            },
            "name": {
              "type": "string",
              "maxLength": 80
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "operations": {
      "type": "object",
      "required": [
        "state",
        "result"
      ],
      "properties": {
        "state": {
          "enum": [
            "pending",
            "done",
            "unknown",
            "not_found"
          ]
        },
        "result": {
          "anyOf": [
            {
              "type": "object",
              "required": [
                "status",
                "body"
              ],
              "properties": {
                "status": {
                  "type": "integer",
                  "minimum": 100,
                  "maximum": 599
                },
                "body": {}
              },
              "additionalProperties": true
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "chats": {
      "type": "object",
      "required": [
        "chats",
        "hasMore",
        "nextCursor"
      ],
      "properties": {
        "chats": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title",
              "updatedAt",
              "taskId",
              "model",
              "state",
              "waiting"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "title": {
                "type": "string",
                "maxLength": 800
              },
              "updatedAt": {
                "type": "integer",
                "minimum": 0
              },
              "taskId": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 128
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "model": {
                "type": "string",
                "maxLength": 200
              },
              "state": {
                "enum": [
                  "idle",
                  "running",
                  "queued"
                ]
              },
              "waiting": {
                "type": "integer",
                "minimum": 0
              },
              "archived": {
                "type": "boolean"
              },
              "purpose": {
                "type": "string",
                "maxLength": 100
              },
              "provider": {
                "$ref": "#/$defs/chat-provider"
              },
              "preview": {
                "type": "string",
                "maxLength": 300
              },
              "modelRef": {
                "$ref": "#/$defs/model-ref"
              },
              "unread": {
                "type": "boolean"
              }
            },
            "additionalProperties": true
          },
          "maxItems": 100
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextCursor": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "chat": {
      "type": "object",
      "required": [
        "chat",
        "messages",
        "hasMore",
        "nextBefore"
      ],
      "properties": {
        "chat": {
          "type": "object",
          "required": [
            "id",
            "title",
            "updatedAt",
            "taskId",
            "model",
            "state",
            "waiting",
            "effort",
            "revision",
            "actions"
          ],
          "properties": {
            "id": {
              "type": "string",
              "maxLength": 128
            },
            "title": {
              "type": "string",
              "maxLength": 800
            },
            "updatedAt": {
              "type": "integer",
              "minimum": 0
            },
            "taskId": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 128
                },
                {
                  "type": "null"
                }
              ]
            },
            "model": {
              "type": "string",
              "maxLength": 200
            },
            "state": {
              "enum": [
                "idle",
                "running",
                "queued"
              ]
            },
            "waiting": {
              "type": "integer",
              "minimum": 0
            },
            "archived": {
              "type": "boolean"
            },
            "purpose": {
              "type": "string",
              "maxLength": 100
            },
            "effort": {
              "type": "string",
              "maxLength": 100
            },
            "revision": {
              "type": "integer",
              "minimum": 0
            },
            "actions": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 256
              }
            },
            "provider": {
              "$ref": "#/$defs/chat-provider"
            },
            "preview": {
              "type": "string",
              "maxLength": 300
            },
            "settings": {
              "$ref": "#/$defs/chat-settings"
            },
            "modelRef": {
              "$ref": "#/$defs/model-ref"
            },
            "unread": {
              "type": "boolean"
            }
          },
          "additionalProperties": true
        },
        "messages": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "index",
              "id",
              "role",
              "turnId",
              "clientId",
              "at",
              "stopped",
              "error",
              "parts",
              "media"
            ],
            "properties": {
              "index": {
                "type": "integer",
                "minimum": 0
              },
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "role": {
                "enum": [
                  "user",
                  "assistant"
                ]
              },
              "turnId": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 128
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "clientId": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 128
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "at": {
                "type": "integer",
                "minimum": 0
              },
              "stopped": {
                "type": "boolean"
              },
              "error": {
                "type": "boolean"
              },
              "parts": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "object",
                      "required": [
                        "type",
                        "text"
                      ],
                      "properties": {
                        "type": {
                          "enum": [
                            "text"
                          ]
                        },
                        "text": {
                          "type": "string",
                          "maxLength": 32768
                        },
                        "truncated": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": true
                    },
                    {
                      "type": "object",
                      "required": [
                        "type",
                        "lang",
                        "text"
                      ],
                      "properties": {
                        "type": {
                          "enum": [
                            "code"
                          ]
                        },
                        "lang": {
                          "type": "string",
                          "maxLength": 100
                        },
                        "text": {
                          "type": "string",
                          "maxLength": 32768
                        },
                        "truncated": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": true
                    },
                    {
                      "type": "object",
                      "required": [
                        "type",
                        "ref",
                        "alt"
                      ],
                      "properties": {
                        "type": {
                          "enum": [
                            "image"
                          ]
                        },
                        "ref": {
                          "type": "string",
                          "maxLength": 4096
                        },
                        "alt": {
                          "type": "string",
                          "maxLength": 800
                        }
                      },
                      "additionalProperties": true
                    }
                  ]
                },
                "maxItems": 200
              },
              "media": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "ref",
                    "alt",
                    "from"
                  ],
                  "properties": {
                    "ref": {
                      "type": "string",
                      "maxLength": 4096
                    },
                    "alt": {
                      "type": "string",
                      "maxLength": 800
                    },
                    "from": {
                      "enum": [
                        "step",
                        "upload"
                      ]
                    }
                  },
                  "additionalProperties": true
                },
                "maxItems": 100
              },
              "activity": {
                "$ref": "#/$defs/chat-activity"
              }
            },
            "additionalProperties": true
          },
          "maxItems": 100
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextBefore": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "activity": {
          "$ref": "#/$defs/chat-activity"
        }
      },
      "additionalProperties": true
    },
    "accepted": {
      "type": "object",
      "required": [
        "accepted",
        "clientId",
        "turnId",
        "state",
        "duplicate"
      ],
      "properties": {
        "accepted": {
          "enum": [
            true
          ]
        },
        "clientId": {
          "type": "string",
          "maxLength": 128
        },
        "turnId": {
          "type": "string",
          "maxLength": 128
        },
        "state": {
          "enum": [
            "started",
            "queued",
            "running",
            "done"
          ]
        },
        "duplicate": {
          "type": "boolean"
        }
      },
      "additionalProperties": true
    },
    "deliveries": {
      "type": "object",
      "required": [
        "deliveries"
      ],
      "properties": {
        "deliveries": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "clientId",
              "turnId",
              "state",
              "outcome"
            ],
            "properties": {
              "clientId": {
                "type": "string",
                "maxLength": 128
              },
              "turnId": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 128
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "state": {
                "enum": [
                  "unknown",
                  "queued",
                  "running",
                  "done"
                ]
              },
              "outcome": {
                "anyOf": [
                  {
                    "enum": [
                      "reply",
                      "stopped",
                      "error",
                      "refused",
                      "interrupted"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": true
          },
          "maxItems": 50
        }
      },
      "additionalProperties": true
    },
    "stop": {
      "type": "object",
      "required": [
        "ok"
      ],
      "properties": {
        "ok": {
          "enum": [
            true
          ]
        }
      },
      "additionalProperties": true
    },
    "waiting": {
      "type": "object",
      "required": [
        "items",
        "hasMore",
        "nextCursor"
      ],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "required": [
                  "pid",
                  "chatId",
                  "kind",
                  "tool",
                  "summary",
                  "details",
                  "acceptsComment",
                  "canRemember",
                  "contentRevision",
                  "hasMore",
                  "nextOffset",
                  "actionToken"
                ],
                "properties": {
                  "pid": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "chatId": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 128
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "kind": {
                    "enum": [
                      "permission"
                    ]
                  },
                  "tool": {
                    "type": "string",
                    "maxLength": 200
                  },
                  "summary": {
                    "type": "string",
                    "maxLength": 800
                  },
                  "details": {
                    "type": "string",
                    "maxLength": 32768
                  },
                  "acceptsComment": {
                    "type": "boolean"
                  },
                  "canRemember": {
                    "enum": [
                      false
                    ]
                  },
                  "contentRevision": {
                    "type": "string",
                    "maxLength": 64
                  },
                  "hasMore": {
                    "type": "boolean"
                  },
                  "nextOffset": {
                    "anyOf": [
                      {
                        "type": "integer",
                        "minimum": 0
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "actionToken": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 256
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": true
              },
              {
                "type": "object",
                "required": [
                  "pid",
                  "chatId",
                  "kind",
                  "prompt",
                  "structured",
                  "actions",
                  "questions",
                  "actionToken"
                ],
                "properties": {
                  "pid": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "chatId": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 128
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "kind": {
                    "enum": [
                      "question"
                    ]
                  },
                  "prompt": {
                    "type": "string",
                    "maxLength": 32768
                  },
                  "structured": {
                    "type": "boolean"
                  },
                  "actions": {
                    "type": "array",
                    "items": {
                      "enum": [
                        "accept",
                        "cancel",
                        "decline"
                      ]
                    },
                    "maxItems": 3
                  },
                  "questions": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": [
                        "id",
                        "header",
                        "question",
                        "multiSelect",
                        "allowFreeText",
                        "inputType",
                        "required",
                        "options",
                        "constraints"
                      ],
                      "properties": {
                        "id": {
                          "type": "string",
                          "maxLength": 128
                        },
                        "header": {
                          "type": "string",
                          "maxLength": 800
                        },
                        "question": {
                          "type": "string",
                          "maxLength": 32768
                        },
                        "multiSelect": {
                          "type": "boolean"
                        },
                        "allowFreeText": {
                          "type": "boolean"
                        },
                        "inputType": {
                          "enum": [
                            "text",
                            "number",
                            "integer",
                            "boolean",
                            "choice",
                            "multi-choice"
                          ]
                        },
                        "required": {
                          "type": "boolean"
                        },
                        "options": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "required": [
                              "id",
                              "label",
                              "description"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "maxLength": 128
                              },
                              "label": {
                                "type": "string",
                                "maxLength": 800
                              },
                              "description": {
                                "type": "string",
                                "maxLength": 4000
                              }
                            },
                            "additionalProperties": true
                          },
                          "maxItems": 100
                        },
                        "constraints": {
                          "type": "object",
                          "required": [],
                          "properties": {
                            "format": {
                              "type": "string",
                              "maxLength": 100
                            },
                            "minLength": {
                              "type": "integer",
                              "minimum": 0
                            },
                            "maxLength": {
                              "type": "integer",
                              "minimum": 0
                            },
                            "minimum": {
                              "type": "number"
                            },
                            "maximum": {
                              "type": "number"
                            },
                            "minItems": {
                              "type": "integer",
                              "minimum": 0
                            },
                            "maxItems": {
                              "type": "integer",
                              "minimum": 0
                            }
                          },
                          "additionalProperties": true
                        }
                      },
                      "additionalProperties": true
                    },
                    "maxItems": 50
                  },
                  "actionToken": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 256
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": true
              },
              {
                "type": "object",
                "required": [
                  "pid",
                  "chatId",
                  "kind",
                  "reason"
                ],
                "properties": {
                  "pid": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "chatId": {
                    "anyOf": [
                      {
                        "type": "string",
                        "maxLength": 128
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "kind": {
                    "enum": [
                      "unsupported"
                    ]
                  },
                  "reason": {
                    "type": "string",
                    "maxLength": 4000
                  }
                },
                "additionalProperties": true
              }
            ]
          },
          "maxItems": 100
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextCursor": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "waiting-result": {
      "type": "object",
      "required": [
        "ok"
      ],
      "properties": {
        "ok": {
          "enum": [
            true
          ]
        },
        "commentDelivered": {
          "type": "boolean"
        },
        "textDelivered": {
          "type": "boolean"
        }
      },
      "additionalProperties": true
    },
    "details": {
      "type": "object",
      "required": [
        "text",
        "contentRevision",
        "hasMore",
        "nextOffset",
        "readToken"
      ],
      "properties": {
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "contentRevision": {
          "type": "string",
          "maxLength": 64
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextOffset": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "readToken": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 256
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "tasks": {
      "type": "object",
      "required": [
        "tasks",
        "hasMore",
        "nextCursor"
      ],
      "properties": {
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title",
              "state",
              "stage",
              "needsHuman",
              "updatedAt"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "title": {
                "type": "string",
                "maxLength": 800
              },
              "state": {
                "enum": [
                  "running",
                  "waiting",
                  "stopped",
                  "done",
                  "idle"
                ]
              },
              "stage": {
                "type": "string",
                "maxLength": 200
              },
              "needsHuman": {
                "anyOf": [
                  {
                    "type": "object",
                    "required": [
                      "kind",
                      "gate",
                      "text",
                      "actionToken"
                    ],
                    "properties": {
                      "kind": {
                        "enum": [
                          "gate",
                          "other"
                        ]
                      },
                      "gate": {
                        "anyOf": [
                          {
                            "type": "string",
                            "maxLength": 128
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "text": {
                        "type": "string",
                        "maxLength": 4000
                      },
                      "actionToken": {
                        "anyOf": [
                          {
                            "type": "string",
                            "maxLength": 256
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "additionalProperties": true
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "updatedAt": {
                "type": "integer",
                "minimum": 0
              }
            },
            "additionalProperties": true
          },
          "maxItems": 100
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextCursor": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "task": {
      "type": "object",
      "required": [
        "task"
      ],
      "properties": {
        "task": {
          "type": "object",
          "required": [
            "id",
            "title",
            "state",
            "stage",
            "needsHuman",
            "updatedAt",
            "stages",
            "actions"
          ],
          "properties": {
            "id": {
              "type": "string",
              "maxLength": 128
            },
            "title": {
              "type": "string",
              "maxLength": 800
            },
            "state": {
              "enum": [
                "running",
                "waiting",
                "stopped",
                "done",
                "idle"
              ]
            },
            "stage": {
              "type": "string",
              "maxLength": 200
            },
            "needsHuman": {
              "anyOf": [
                {
                  "type": "object",
                  "required": [
                    "kind",
                    "gate",
                    "text",
                    "actionToken"
                  ],
                  "properties": {
                    "kind": {
                      "enum": [
                        "gate",
                        "other"
                      ]
                    },
                    "gate": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 128
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "text": {
                      "type": "string",
                      "maxLength": 4000
                    },
                    "actionToken": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 256
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "additionalProperties": true
                },
                {
                  "type": "null"
                }
              ]
            },
            "updatedAt": {
              "type": "integer",
              "minimum": 0
            },
            "stages": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "key",
                  "title",
                  "status"
                ],
                "properties": {
                  "key": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "title": {
                    "type": "string",
                    "maxLength": 800
                  },
                  "status": {
                    "enum": [
                      "done",
                      "running",
                      "waiting",
                      "failed",
                      "idle"
                    ]
                  }
                },
                "additionalProperties": true
              },
              "maxItems": 100
            },
            "actions": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 256
              }
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "plan": {
      "type": "object",
      "required": [
        "text",
        "contentRevision",
        "hasMore",
        "nextOffset",
        "readToken"
      ],
      "properties": {
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "contentRevision": {
          "type": "string",
          "maxLength": 64
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextOffset": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "readToken": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 256
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "gate": {
      "type": "object",
      "required": [
        "ok",
        "resumed",
        "resumeError"
      ],
      "properties": {
        "ok": {
          "enum": [
            true
          ]
        },
        "resumed": {
          "type": "boolean"
        },
        "resumeError": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 4000
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "resume": {
      "type": "object",
      "required": [
        "ok"
      ],
      "properties": {
        "ok": {
          "enum": [
            true
          ]
        }
      },
      "additionalProperties": true
    },
    "b24-tasks": {
      "type": "object",
      "required": [
        "tasks",
        "hasMore",
        "nextCursor"
      ],
      "properties": {
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title",
              "status",
              "deadline",
              "priority",
              "onPipeline"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "title": {
                "type": "string",
                "maxLength": 800
              },
              "status": {
                "type": "string",
                "maxLength": 800
              },
              "deadline": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": 0
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "priority": {
                "type": "number"
              },
              "onPipeline": {
                "type": "boolean"
              }
            },
            "additionalProperties": true
          },
          "maxItems": 100
        },
        "hasMore": {
          "type": "boolean"
        },
        "nextCursor": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "b24-task": {
      "type": "object",
      "required": [
        "task"
      ],
      "properties": {
        "task": {
          "type": "object",
          "required": [
            "id",
            "title",
            "description",
            "status",
            "deadline",
            "responsible"
          ],
          "properties": {
            "id": {
              "type": "string",
              "maxLength": 128
            },
            "title": {
              "type": "string",
              "maxLength": 800
            },
            "description": {
              "type": "string",
              "maxLength": 32768
            },
            "status": {
              "type": "string",
              "maxLength": 800
            },
            "deadline": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "responsible": {
              "type": "string",
              "maxLength": 800
            },
            "truncated": {
              "type": "boolean"
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "launch-options": {
      "type": "object",
      "required": [
        "options",
        "defaultId",
        "actionToken",
        "reason"
      ],
      "properties": {
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "title": {
                "type": "string",
                "maxLength": 800
              },
              "disabledReason": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 4000
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": true
          },
          "maxItems": 100
        },
        "defaultId": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "actionToken": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 256
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 4000
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": true
    },
    "launch": {
      "type": "object",
      "required": [
        "ok"
      ],
      "properties": {
        "ok": {
          "enum": [
            true
          ]
        }
      },
      "additionalProperties": true
    },
    "app": {
      "type": "object",
      "required": [
        "version",
        "versionCode",
        "size",
        "sha256"
      ],
      "properties": {
        "version": {
          "type": "string",
          "maxLength": 40
        },
        "versionCode": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2100000000
        },
        "size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 268435456
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "additionalProperties": true
    },
    "error": {
      "type": "object",
      "required": [
        "error",
        "message"
      ],
      "properties": {
        "error": {
          "type": "string",
          "maxLength": 100
        },
        "message": {
          "type": "string",
          "maxLength": 4000
        }
      },
      "additionalProperties": true
    },
    "operation-pending": {
      "type": "object",
      "required": [
        "operationPending"
      ],
      "properties": {
        "operationPending": {
          "enum": [
            true
          ]
        }
      },
      "additionalProperties": true
    },
    "send-request": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "maxLength": 20000
        },
        "clientId": {
          "type": "string",
          "maxLength": 80
        }
      },
      "required": [
        "text",
        "clientId"
      ],
      "additionalProperties": true
    },
    "action-request": {
      "type": "object",
      "properties": {
        "actionToken": {
          "type": "string",
          "maxLength": 48
        }
      },
      "required": [
        "actionToken"
      ],
      "additionalProperties": true
    },
    "gate-request": {
      "type": "object",
      "properties": {
        "gate": {
          "type": "string",
          "maxLength": 80
        },
        "decision": {
          "enum": [
            "approve",
            "reject"
          ]
        },
        "comment": {
          "type": "string",
          "maxLength": 4000
        },
        "actionToken": {
          "type": "string",
          "maxLength": 48
        }
      },
      "required": [
        "gate",
        "decision",
        "comment",
        "actionToken"
      ],
      "additionalProperties": true
    },
    "launch-request": {
      "type": "object",
      "properties": {
        "optionId": {
          "type": "string",
          "maxLength": 80
        },
        "actionToken": {
          "type": "string",
          "maxLength": 48
        }
      },
      "required": [
        "optionId",
        "actionToken"
      ],
      "additionalProperties": true
    },
    "waiting-request": {
      "type": "object",
      "properties": {
        "decision": {
          "enum": [
            "allow",
            "deny"
          ]
        },
        "comment": {
          "type": "string",
          "maxLength": 4000
        },
        "action": {
          "enum": [
            "accept",
            "cancel",
            "decline"
          ]
        },
        "actionToken": {
          "type": "string",
          "maxLength": 48
        },
        "answers": {
          "type": "array",
          "maxItems": 50,
          "items": {
            "type": "object",
            "properties": {
              "questionId": {
                "type": "string",
                "maxLength": 80
              },
              "optionIds": {
                "type": "array",
                "maxItems": 100,
                "items": {
                  "type": "string",
                  "maxLength": 80
                }
              },
              "text": {
                "type": "string",
                "maxLength": 4000
              },
              "value": {}
            },
            "required": [
              "questionId"
            ],
            "additionalProperties": true
          }
        }
      },
      "required": [
        "actionToken"
      ],
      "additionalProperties": true
    },
    "pair-request": {
      "type": "object",
      "required": [
        "code",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string",
          "maxLength": 100
        },
        "name": {
          "type": "string",
          "maxLength": 200
        }
      },
      "additionalProperties": true
    },
    "chat-provider": {
      "type": "object",
      "required": [
        "id",
        "name",
        "color"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 80
        },
        "name": {
          "type": "string",
          "maxLength": 200
        },
        "color": {
          "type": "string",
          "pattern": "^#[A-Fa-f0-9]{6}$"
        }
      },
      "additionalProperties": true
    },
    "chat-activity": {
      "type": "object",
      "required": [
        "items",
        "omitted"
      ],
      "properties": {
        "items": {
          "type": "array",
          "maxItems": 400,
          "items": {
            "type": "object",
            "required": [
              "id",
              "kind",
              "title",
              "text",
              "result",
              "state",
              "at"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 200
              },
              "kind": {
                "enum": [
                  "tool",
                  "think",
                  "text",
                  "note"
                ]
              },
              "title": {
                "type": "string",
                "maxLength": 200
              },
              "text": {
                "type": "string",
                "maxLength": 6000
              },
              "result": {
                "type": "string",
                "maxLength": 6000
              },
              "state": {
                "enum": [
                  "running",
                  "done",
                  "error"
                ]
              },
              "at": {
                "type": "integer",
                "minimum": 0
              }
            },
            "additionalProperties": true
          }
        },
        "omitted": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "model-ref": {
      "type": "object",
      "required": [
        "provider",
        "model"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "maxLength": 200
        },
        "model": {
          "type": "string",
          "maxLength": 200
        }
      },
      "additionalProperties": true
    },
    "workdir-choice": {
      "anyOf": [
        {
          "type": "object",
          "required": [
            "kind"
          ],
          "properties": {
            "kind": {
              "enum": [
                "cockpit"
              ]
            }
          },
          "additionalProperties": true
        },
        {
          "type": "object",
          "required": [
            "kind",
            "projectId",
            "repoKey"
          ],
          "properties": {
            "kind": {
              "enum": [
                "project"
              ]
            },
            "projectId": {
              "type": "string",
              "maxLength": 200
            },
            "repoKey": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 64
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "additionalProperties": true
        },
        {
          "type": "object",
          "required": [
            "kind",
            "path"
          ],
          "properties": {
            "kind": {
              "enum": [
                "path"
              ]
            },
            "path": {
              "type": "string",
              "maxLength": 4096
            }
          },
          "additionalProperties": true
        }
      ]
    },
    "chat-context": {
      "type": "object",
      "required": [
        "tokens",
        "window",
        "metric",
        "estimate",
        "live",
        "compactWindow"
      ],
      "properties": {
        "tokens": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "window": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "metric": {
          "type": "string",
          "maxLength": 120
        },
        "estimate": {
          "type": "boolean"
        },
        "live": {
          "type": "boolean"
        },
        "compactWindow": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "chat-settings": {
      "type": "object",
      "required": [
        "modelRef",
        "workdir",
        "directory",
        "context"
      ],
      "properties": {
        "modelRef": {
          "anyOf": [
            {
              "$ref": "#/$defs/model-ref"
            },
            {
              "type": "null"
            }
          ]
        },
        "workdir": {
          "$ref": "#/$defs/workdir-choice"
        },
        "directory": {
          "type": "string",
          "maxLength": 4096
        },
        "context": {
          "$ref": "#/$defs/chat-context"
        }
      },
      "additionalProperties": true
    },
    "chat-model": {
      "type": "object",
      "required": [
        "provider",
        "providerName",
        "id",
        "name",
        "efforts",
        "context",
        "contextVerified",
        "autoCompact",
        "available"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "maxLength": 200
        },
        "providerName": {
          "type": "string",
          "maxLength": 200
        },
        "id": {
          "type": "string",
          "maxLength": 200
        },
        "name": {
          "type": "string",
          "maxLength": 200
        },
        "efforts": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 120
          },
          "maxItems": 50
        },
        "context": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "contextVerified": {
          "type": "boolean"
        },
        "autoCompact": {
          "type": "boolean"
        },
        "available": {
          "type": "boolean"
        }
      },
      "additionalProperties": true
    },
    "chat-options": {
      "type": "object",
      "required": [
        "models",
        "defaultModelRef",
        "tasks",
        "projects",
        "tasksOmitted",
        "projectsOmitted"
      ],
      "properties": {
        "models": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/chat-model"
          },
          "maxItems": 1000
        },
        "defaultModelRef": {
          "anyOf": [
            {
              "$ref": "#/$defs/model-ref"
            },
            {
              "type": "null"
            }
          ]
        },
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 200
              },
              "title": {
                "type": "string",
                "maxLength": 800
              }
            },
            "additionalProperties": true
          },
          "maxItems": 2000
        },
        "projects": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "id",
              "title"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 200
              },
              "title": {
                "type": "string",
                "maxLength": 800
              }
            },
            "additionalProperties": true
          },
          "maxItems": 500
        },
        "tasksOmitted": {
          "type": "integer",
          "minimum": 0
        },
        "projectsOmitted": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "chat-result": {
      "type": "object",
      "required": [
        "id",
        "revision"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "revision": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "workspace-preview": {
      "type": "object",
      "required": [
        "directory",
        "previousDirectory",
        "transfer",
        "summaryAvailable",
        "warnings",
        "actionToken"
      ],
      "properties": {
        "directory": {
          "type": "string",
          "maxLength": 4096
        },
        "previousDirectory": {
          "type": "string",
          "maxLength": 4096
        },
        "transfer": {
          "enum": [
            "none",
            "resume",
            "reseed",
            "unavailable"
          ]
        },
        "summaryAvailable": {
          "type": "boolean"
        },
        "warnings": {
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 4000
          },
          "maxItems": 100
        },
        "actionToken": {
          "type": "string",
          "maxLength": 8192
        }
      },
      "additionalProperties": true
    },
    "attention": {
      "type": "object",
      "required": [
        "chats",
        "tasks"
      ],
      "properties": {
        "chats": {
          "type": "object",
          "required": [
            "waiting",
            "unread",
            "running"
          ],
          "properties": {
            "waiting": {
              "type": "integer",
              "minimum": 0
            },
            "unread": {
              "type": "integer",
              "minimum": 0
            },
            "running": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": true
        },
        "tasks": {
          "type": "object",
          "required": [
            "waiting",
            "stalled",
            "running"
          ],
          "properties": {
            "waiting": {
              "type": "integer",
              "minimum": 0
            },
            "stalled": {
              "type": "integer",
              "minimum": 0
            },
            "running": {
              "type": "integer",
              "minimum": 0
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "chat-create-request": {
      "type": "object",
      "required": [
        "modelRef"
      ],
      "properties": {
        "modelRef": {
          "$ref": "#/$defs/model-ref"
        }
      },
      "additionalProperties": false
    },
    "chat-settings-request": {
      "type": "object",
      "required": [
        "modelRef",
        "effort",
        "reset",
        "actionToken"
      ],
      "properties": {
        "modelRef": {
          "$ref": "#/$defs/model-ref"
        },
        "effort": {
          "type": "string",
          "maxLength": 120
        },
        "reset": {
          "type": "boolean"
        },
        "actionToken": {
          "type": "string",
          "maxLength": 8192
        }
      },
      "additionalProperties": false
    },
    "workspace-request": {
      "type": "object",
      "required": [
        "taskId",
        "workdir"
      ],
      "properties": {
        "taskId": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "workdir": {
          "$ref": "#/$defs/workdir-choice"
        }
      },
      "additionalProperties": false
    },
    "workspace-change-request": {
      "type": "object",
      "required": [
        "actionToken",
        "transfer"
      ],
      "properties": {
        "actionToken": {
          "type": "string",
          "maxLength": 8192
        },
        "transfer": {
          "enum": [
            "resume",
            "summary",
            "reset"
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "x-http": [
    {
      "method": "GET",
      "path": "/api/mobile/v1/hello",
      "response": "hello",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/pair",
      "response": "pair",
      "status": 200,
      "headers": [],
      "request": "pair-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/operations/:key",
      "response": "operations",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/chats",
      "response": "chats",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/chats/:id",
      "response": "chat",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/messages",
      "response": "accepted",
      "status": 202,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "send-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/chats/:id/deliveries",
      "response": "deliveries",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/stop",
      "response": "stop",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "action-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/waiting",
      "response": "waiting",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/waiting/:pid/details",
      "response": "details",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/waiting/:pid",
      "response": "waiting-result",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "waiting-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/tasks",
      "response": "tasks",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/tasks/:id",
      "response": "task",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/tasks/:id/plan",
      "response": "plan",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/tasks/:id/gate",
      "response": "gate",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "gate-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/tasks/:id/resume",
      "response": "resume",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "action-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/tasks/:id/stop",
      "response": "stop",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "action-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/b24/tasks",
      "response": "b24-tasks",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/b24/tasks/:id",
      "response": "b24-task",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/b24/tasks/:id/launch-options",
      "response": "launch-options",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/b24/tasks/:id/launch",
      "response": "launch",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "launch-request"
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/app",
      "response": "app",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/chats/:id/media/:ref",
      "response": "binary-raster",
      "status": [
        200,
        304
      ]
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/events",
      "response": "sse-v1",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/app/apk",
      "response": "binary-apk",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/chat-options",
      "response": "chat-options",
      "status": 200
    },
    {
      "method": "GET",
      "path": "/api/mobile/v1/attention",
      "response": "attention",
      "status": 200
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats",
      "response": "chat-result",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "chat-create-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/settings",
      "response": "chat-result",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "chat-settings-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/read",
      "response": "chat-result",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "action-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/workspace/preview",
      "response": "workspace-preview",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "workspace-request"
    },
    {
      "method": "POST",
      "path": "/api/mobile/v1/chats/:id/workspace",
      "response": "chat-result",
      "status": 200,
      "headers": [
        "Idempotency-Key",
        "X-Cockpit-Operation-Created-At"
      ],
      "request": "workspace-change-request"
    }
  ],
  "x-errors": {
    "bad_request": 400,
    "bad_text": 400,
    "device_unknown": 401,
    "device_revoked": 403,
    "state_changed": 409,
    "history_changed": 409,
    "list_changed": 409,
    "content_changed": 409,
    "content_not_read": 409,
    "operation_unknown": 409,
    "operation_expired": 409,
    "idempotency_conflict": 409,
    "already_resolved": 409,
    "media_type": 415,
    "media_not_found": 404,
    "no_apk": 404,
    "no_plan": 404,
    "model_unavailable": 409,
    "upstream_auth": 502,
    "media_busy": 503
  }
} as const;
