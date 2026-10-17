#!/usr/bin/env bash
# Проверяет строгость валидатора и выбор всех подходящих веток без доверия к журналу.
# Корпус публичных API сравнивается с полным перебором; эталон всей реализации хранится отдельно.
set -uo pipefail

python3 - "$FACTORY_HOME/lib/attempt-lifecycle-state.py" \
  "$FACTORY_HOME/../schemas/analytics/lifecycle-event.schema.json" \
  "$FACTORY_TESTS_HOME/../fixtures/analytics/lifecycle-event-vectors.json" <<'PY'
import copy
import hashlib
import importlib.util
import json
import pathlib
import sys
import unittest


module_path, schema_path, vectors_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("lifecycle_validator", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
vectors = json.loads(pathlib.Path(vectors_path).read_text(encoding="utf-8"))


class FullScanContract(module.Contract):
    """Сохраняет общий валидатор, но посещает все ветки oneOf.
    Это дополнительный эталон выбора веток, а не независимый эталон канонизации.
    """

    def _one_of_candidates(self, one_of, where, value):
        return one_of


class CountingContract(module.Contract):
    """Считает посещения именно верхних веток схемы.
    Вложенные проверки details не должны увеличивать этот счётчик.
    """

    def __init__(self, path):
        super().__init__(path)
        self.branch_ids = {id(branch) for branch in self.schema["oneOf"]}
        self.visited = 0

    def _schema_errors(self, value, schema, where, **kwargs):
        if id(schema) in self.branch_ids:
            self.visited += 1

        return super()._schema_errors(value, schema, where, **kwargs)


def event_for(kind):
    """Строит самостоятельное событие из публичных vectors для каждого kind.
    Настоящий eventHash позволяет проверять успешный parse_event_line независимо от schema.
    """
    case = vectors["kindCases"][kind]
    event = copy.deepcopy(vectors["draft"])
    event.update(copy.deepcopy(vectors["identityClasses"][case["identityClass"]]))
    event["kind"] = kind
    event["details"] = copy.deepcopy(case["details"])
    event.update(sequence=1, previousEventHash=None, eventHash="0" * 64)
    event["eventHash"] = module.event_hash(event)

    return event


def json_line(value):
    """Кодирует вход, включая намеренно невалидные строки и числа.
    Суррогаты передаются JSON escape, чтобы отказ происходил внутри публичного API.
    """
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    try:
        return text.encode("utf-8") + b"\n"
    except UnicodeEncodeError:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode() + b"\n"


def corpus():
    """Сохраняет базовые 364 входа и дополняет их граничными мутациями.
    Имена и порядок детерминированы; генератор общий для старой и новой реализаций.
    """
    cases = []
    for kind in sorted(vectors["kindCases"]):
        valid = event_for(kind)
        cases.append((kind + "/valid", valid))
        mutations = {
            "missing-kind": lambda event: event.pop("kind"),
            "unknown-kind": lambda event: event.update(kind="unknown"),
            "null-kind": lambda event: event.update(kind=None),
            "wrong-details": lambda event: event.update(details={"unexpected": True}),
            "extra-field": lambda event: event.update(unexpected=True),
            "boolean-clock": lambda event: event["clock"].update(monotonicNs=True),
            "float-clock": lambda event: event["clock"].update(monotonicNs=1.5),
            "bad-id": lambda event: event.update(eventId="bad"),
        }
        for label, mutate in mutations.items():
            event = copy.deepcopy(valid)
            mutate(event)
            cases.append((kind + "/" + label, event))

    cases.extend(("non-object/" + str(index), value) for index, value in enumerate([None, [], True, 1]))
    assert len(cases) == 364

    for kind in sorted(vectors["kindCases"]):
        for value in [True, 1, "1", None, module.SAFE_INTEGER, module.SAFE_INTEGER + 1, 1.5]:
            event = event_for(kind)
            event["details"]["reasonCode"] = value
            cases.append((kind + "/reasonCode/" + repr(value), event))

        for label, value in [
            ("surrogate-value", {"nested": ["\ud800"]}),
            ("surrogate-key", {"\udfff": None}),
            ("nested-float", {"nested": [1.5]}),
            ("details-null", None),
            ("details-array", []),
        ]:
            event = event_for(kind)
            event["details"] = value
            cases.append((kind + "/" + label, event))

    for value in [True, 1, "1", None, module.SAFE_INTEGER + 1, 1.5]:
        event = event_for("attempt_started")
        event["schemaVersion"] = value
        cases.append(("schemaVersion/" + repr(value), event))

    for label, value in [
        ("surrogate", "\ud800"),
        ("surrogate-long", "x" * 1000 + "\udfff"),
        ("unicode", "Кириллица😀\ud7ff\ue000"),
    ]:
        event = event_for("attempt_started")
        event["writerVersion"] = value
        if label == "unicode":
            event["eventHash"] = module.event_hash(event)

        cases.append(("writerVersion/" + label, event))

    return cases


def verdict(call, *, canonical=False):
    """Нормализует только объявленные LifecycleFailure, сохраняя name/code.
    Любое неизвестное исключение проваливает проверку; диагностика не входит в контракт.
    """
    try:
        result = call()
    except module.LifecycleFailure as error:
        return {
            "status": "failure",
            "name": error.name,
            "code": error.code,
        }

    result_bytes = module.canonical_bytes(result).hex() if canonical else None
    return {
        "status": "ok",
        "bytes": result_bytes,
    }


def line_cases():
    """Подготавливает успешную цепочку и нарушения каждой границы reader-а.
    Hash обновляется при нарушении sequence/identity, чтобы тест доходил до нужной проверки.
    """
    first = event_for("attempt_started")
    second = event_for("attempt_started")
    second.update(sequence=2, previousEventHash=first["eventHash"], eventId="ev_" + "2" * 32)
    second["eventHash"] = module.event_hash(second)
    rows = [
        ("first", json_line(first), 1, None, True),
        ("second", json_line(second), 2, first["eventHash"], True),
        ("wrong-sequence", json_line(first), 2, None, False),
        ("wrong-previous", json_line(second), 2, "f" * 64, False),
        ("invalid-utf8", b"\xff\n", 1, None, False),
        ("torn", json_line(first)[:-1], 1, None, False),
        ("empty", b"\n", 1, None, False),
        ("noncanonical", json.dumps(first).encode() + b"\n", 1, None, False),
    ]
    bad_hash = copy.deepcopy(first)
    bad_hash["eventHash"] = "f" * 64
    rows.append(("wrong-hash", json_line(bad_hash), 1, None, False))
    for field, value in [("taskId", "t43"), ("attemptId", "a_" + "f" * 32)]:
        event = copy.deepcopy(first)
        event[field] = value
        event["eventHash"] = module.event_hash(event)
        rows.append(("wrong-" + field, json_line(event), 1, None, False))

    duplicate = b'{"sequence":1,' + json_line(first)[1:]
    rows.append(("duplicate-key", duplicate, 1, None, False))

    return rows


def public_report(contract):
    """Фиксирует три публичных пути, включая draft и full validate_event.
    Contract.validate не получает дополнительной canonical-проверки после своего успеха.
    """
    report = {}
    for case_id, event in corpus():
        draft = copy.deepcopy(event)
        if isinstance(draft, dict):
            for key in module.CHAIN_KEYS:
                draft.pop(key, None)

        report[case_id] = {
            "contract": verdict(lambda: contract.validate(event)),
            "full": verdict(lambda: module.validate_event(event, contract, draft=False), canonical=True),
            "draft": verdict(lambda: module.validate_event(draft, contract, draft=True), canonical=True),
            "line": verdict(lambda: module.parse_event_line(
                json_line(event), contract, "t42", vectors["draft"]["attemptId"], 1, None, case_id
            ), canonical=True),
        }

    for case_id, line, sequence, previous, expected in line_cases():
        report["ledger/" + case_id] = verdict(lambda: module.parse_event_line(
            line, contract, "t42", vectors["draft"]["attemptId"], sequence, previous, case_id
        ), canonical=True)

    return report


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.contract = module.Contract(schema_path)

    def synthetic(self, branches, definitions=None):
        """Удерживает синтетические узлы в новом Contract до обращения к кэшу.
        Не изменяет уже закэшированную schema и не допускает повторного использования id.
        """
        contract = module.Contract(schema_path)
        contract.defs.update(definitions or {})
        wrapper = {"oneOf": branches}
        contract.defs["validatorFixture"] = wrapper

        return contract, wrapper

    def assert_schema_failure(self, call):
        """Проверяет штатный отказ schema вместо сырого TypeError распознавателя.
        В повреждённых схемах совместимость произвольной диагностики не обещается.
        """
        result = verdict(call)
        self.assertEqual(result, {
            "status": "failure",
            "name": "lifecycle-schema-invalid",
            "code": 78,
        })

    def test_valid_kinds_and_unknown_inputs(self):
        """Каждый fixture обязан проходить schema и ровно одну полную ветку.
        Одновременный отказ двух сравниваемых реализаций не считается успешным fixture.
        """
        schema = self.contract.schema
        kinds = set(vectors["kindCases"])
        self.assertEqual(kinds, self.contract.kinds)
        branches = [self.contract._resolve(branch["$ref"], "$") for branch in schema["oneOf"]]
        self.assertEqual(kinds, {branch["properties"]["kind"]["const"] for branch in branches})

        for kind in sorted(kinds):
            event = event_for(kind)
            with self.subTest(kind=kind):
                self.contract.validate(event)
                self.assertEqual(sum(
                    not self.contract._schema_errors(event, branch, "$") for branch in schema["oneOf"]
                ), 1)
                self.assertEqual(module.validate_event(event, self.contract, draft=False), event)
                draft = {key: value for key, value in event.items() if key not in module.CHAIN_KEYS}
                if kind == "lifecycle_tail_recovered":
                    self.assert_schema_failure(lambda: module.validate_event(
                        draft, self.contract, draft=True
                    ))
                else:
                    self.assertEqual(module.validate_event(draft, self.contract, draft=True), draft)

                parsed = module.parse_event_line(
                    module.canonical_bytes(event) + b"\n", self.contract,
                    "t42", event["attemptId"], 1, None, kind
                )
                self.assertEqual(parsed, event)

        for case_id, event in corpus()[:364]:
            if not case_id.endswith("/valid"):
                with self.subTest(case=case_id):
                    self.assert_schema_failure(lambda: self.contract.validate(event))

    def test_branch_visits(self):
        """Закрепляет устранение полного перебора без измерения wall-clock.
        Отсутствующий или неизвестный дискриминатор не посещает ни одной верхней ветки.
        """
        contract = CountingContract(schema_path)
        for kind in sorted(vectors["kindCases"]):
            contract.visited = 0
            contract.validate(event_for(kind))
            self.assertEqual(contract.visited, 1, kind)

        for value in [{}, {"kind": "unknown"}, None]:
            contract.visited = 0
            self.assertTrue(contract._schema_errors(value, {"oneOf": contract.schema["oneOf"]}, "$"))
            self.assertEqual(contract.visited, 0)

    def test_fallback_and_plan_shape(self):
        """Неподходящая форма возвращает исходный список веток и штатную ошибку.
        Цепочка refs не оптимизируется; ошибку разрешения ссылки распознаватель не скрывает.
        """
        self.assertTrue(hasattr(self.contract, "_one_of_plan"), "нужен распознаватель oneOf")
        supported = {
            "type": "object",
            "required": ["tag"],
            "properties": {"tag": {"const": "a"}},
        }
        optional_tag = {
            "type": "object",
            "properties": {"tag": {"const": "a"}},
        }
        typed_tag = {
            "const": "a",
            "type": "string",
        }
        shapes = [
            [{"type": "null"}, supported],
            [{"type": "string"}, {"type": "integer"}],
            [optional_tag, supported],
            [dict(supported, properties=[]), supported],
            [dict(supported, required="tag"), supported],
            [dict(supported, required=[{}]), supported],
            [dict(supported, required=[1]), supported],
            [dict(supported, properties={"tag": typed_tag}), supported],
            [{"$ref": "#/$defs/alias"}, supported],
            [True, supported],
        ]
        for branches in shapes:
            contract, wrapper = self.synthetic(branches, {
                "alias": {"$ref": "#/$defs/target"},
                "target": supported,
            })
            with self.subTest(branches=branches):
                self.assertIsNone(contract._one_of_plan(branches, "$"))
                self.assertIs(contract._one_of_candidates(branches, "$", {}), branches)

        for keyword, value in [("required", [{}]), ("required", 1), ("properties", [])]:
            contract, wrapper = self.synthetic([dict(supported, **{keyword: value})])
            self.assert_schema_failure(lambda: contract._schema_errors({"tag": "a"}, wrapper, "$"))

        contract, wrapper = self.synthetic([{"$ref": "#/$defs/missing"}])
        self.assert_schema_failure(lambda: contract._one_of_plan(wrapper["oneOf"], "$"))
        self.assert_schema_failure(lambda: contract._schema_errors({}, {"oneOf": {}}, "$"))

    def test_fallback_validation(self):
        """Проверяет реальные вердикты nullable/mixed union и цепочки ссылок.
        Наличие fallback должно сохранять как успешные случаи, так и неоднозначность oneOf.
        """
        tagged = {
            "type": "object",
            "required": ["tag"],
            "properties": {"tag": {"const": "a"}},
        }
        groups = [
            ([{"type": "null"}, tagged], [None, {"tag": "a"}], [{}, {"tag": "b"}]),
            ([{"type": "string"}, {"type": "integer"}], ["", 1], [True, None]),
            ([{"$ref": "#/$defs/alias"}, {"type": "null"}], [None, {"tag": "a"}], [True, {}]),
            ([{"type": "object"}, {"type": "object"}], [], [{}, {"tag": "a"}]),
        ]
        for branches, accepted, rejected in groups:
            contract, wrapper = self.synthetic(branches, {
                "alias": {"$ref": "#/$defs/target"},
                "target": tagged,
            })
            for value in accepted:
                self.assertEqual(contract._schema_errors(value, wrapper, "$"), [])

            for value in rejected:
                self.assertTrue(contract._schema_errors(value, wrapper, "$"))

    def test_duplicate_constants_and_discriminators(self):
        """Таблица сохраняет все ветки с одинаковым const и выбирает min общего имени.
        Два совпадения запрещены oneOf, но один кандидат из такой группы может быть принят.
        """
        self.assertTrue(hasattr(self.contract, "_one_of_candidates"), "нужен выбор кандидатов")
        first = {
            "type": "object",
            "required": ["z", "a", "payload"],
            "properties": {
                "z": {"const": "same"},
                "a": {"const": True},
                "payload": {"const": 1},
            },
        }
        second = copy.deepcopy(first)
        second["properties"]["payload"] = {"const": 2}
        contract, wrapper = self.synthetic([first, {"$ref": "#/$defs/second"}], {"second": second})
        branches = wrapper["oneOf"]
        self.assertEqual(contract._one_of_plan(branches, "$")[0], "a")
        planned = []
        original = contract._one_of_plan

        def counted_plan(one_of, where):
            planned.append(one_of)
            return original(one_of, where)

        contract._one_of_plan = counted_plan
        selected = contract._one_of_candidates(branches, "$", {"a": True})
        self.assertEqual(selected, branches)
        self.assertIs(contract._one_of_candidates(branches, "$", {"a": True}), selected)
        self.assertEqual(len(planned), 1)
        matching = {
            "a": True,
            "z": "same",
            "payload": 1,
        }
        self.assertEqual(contract._schema_errors(matching, wrapper, "$"), [])

        for value in [1, "1", None]:
            self.assertEqual(contract._one_of_candidates(branches, "$", {"a": value}), [])

        for value in [None, {}, []]:
            self.assertEqual(contract._one_of_candidates(branches, "$", value), [])

        contract, wrapper = self.synthetic([first, copy.deepcopy(first)])
        self.assertTrue(contract._schema_errors(matching, wrapper, "$"))

        structured = {
            "b": 1,
            "a": [True],
        }
        branches = [
            {
                "type": "object",
                "required": ["tag"],
                "properties": {"tag": {"const": value}},
            }
            for value in [True, 1, "1", None, structured]
        ]
        contract, wrapper = self.synthetic(branches)
        for branch in branches:
            tag = branch["properties"]["tag"]["const"]
            self.assertEqual(contract._one_of_candidates(branches, "$", {"tag": tag}), [branch])
            self.assertEqual(contract._schema_errors({"tag": tag}, wrapper, "$"), [])

    def test_constant_cache_and_canonical_distinctions(self):
        """Кэширует только schema; boolean, integer и структурные JSON различаются.
        Значение события продолжает кодироваться при каждом сравнении с прогретым кэшем.
        """
        self.assertTrue(hasattr(self.contract, "_constant_set"), "нужен кэш const/enum")
        structured = {
            "b": [True, 1],
            "a": None,
        }
        for keyword, value in [("const", structured), ("enum", [True, 1, "1", None])]:
            contract = module.Contract(schema_path)
            schema = {keyword: value}
            contract.defs["constantFixture"] = schema
            calls = []
            original = module.canonical_bytes

            def counted(item, *args):
                calls.append(item)
                return original(item, *args)

            module.canonical_bytes = counted
            try:
                choices = contract._constant_set(schema, keyword)
                count = len(calls)
                self.assertIs(contract._constant_set(schema, keyword), choices)
                self.assertEqual(len(calls), count)
                self.assertIsInstance(choices, frozenset)
                reordered = {
                    "a": None,
                    "b": [True, 1],
                }
                matching = reordered if keyword == "const" else True
                self.assertEqual(contract._schema_errors(matching, schema, "$"), [])
                self.assertEqual(len(calls), count + 1)
            finally:
                module.canonical_bytes = original

        for constant in [True, 1, "1", None]:
            contract = module.Contract(schema_path)
            schema = {"const": constant}
            contract.defs["constantFixture"] = schema
            for value in [True, 1, "1", None]:
                errors = contract._schema_errors(value, schema, "$")
                self.assertEqual(bool(errors), type(value) is not type(constant))

        contract = module.Contract(schema_path)
        empty = {"enum": []}
        contract.defs["constantFixture"] = empty
        for value in [True, 1, "1", None, [], {}]:
            self.assertTrue(contract._schema_errors(value, empty, "$"))

        contract = module.Contract(schema_path)
        constant = {
            "z": [1, True],
            "a": None,
        }
        reordered = {
            "a": None,
            "z": [1, True],
        }
        different = {
            "a": None,
            "z": [True, 1],
        }
        structural = {"enum": [constant]}
        contract.defs["constantFixture"] = structural
        self.assertEqual(contract._schema_errors(reordered, structural, "$"), [])
        self.assertTrue(contract._schema_errors(different, structural, "$"))
        self.assert_schema_failure(lambda: contract._schema_errors(None, {"enum": {}}, "$"))
        self.assertEqual(contract._schema_errors(None, {"enum": None}, "$"), [])

    def test_unicode_boundaries(self):
        """Каждый суррогат запрещён и как строка, и внутри вложенного JSON.
        Соседние code points, кириллица и emoji остаются допустимы, включая пустую строку.
        """
        for point in range(0xD800, 0xE000):
            self.assert_schema_failure(lambda: module.canonical_bytes(chr(point)))

        for value in ["", "\ud7ff", "\ue000", "Кириллица", "😀"]:
            self.assertEqual(json.loads(module.canonical_bytes(value)), value)

        for value in ["x" * 20000 + "\ud800", {"a": ["\udfff"]}, {"\ud800": 1}]:
            self.assert_schema_failure(lambda: module.canonical_bytes(value))

        contract = module.Contract(schema_path)
        contract.schema = {"type": "string"}
        contract.validate("\ud800")

    def test_public_paths_and_full_scan(self):
        """Сверяет весь детерминированный корпус с полным перебором oneOf.
        На строках ledger независимо проверяет успех либо обёртку lifecycle-corruption.
        """
        self.assertEqual(public_report(self.contract), public_report(FullScanContract(schema_path)))
        for case_id, line, sequence, previous, expected in line_cases():
            result = verdict(lambda: module.parse_event_line(
                line, self.contract, "t42", vectors["draft"]["attemptId"], sequence, previous, case_id
            ))
            self.assertEqual(result["status"], "ok" if expected else "failure", case_id)
            if not expected:
                self.assertEqual(result["name"], "lifecycle-corruption", case_id)
                self.assertEqual(result["code"], 78, case_id)


if len(sys.argv) == 6 and sys.argv[4] == "--report":
    report = public_report(module.Contract(schema_path))
    output = {
        "moduleSha256": hashlib.sha256(pathlib.Path(module_path).read_bytes()).hexdigest(),
        "schemaSha256": hashlib.sha256(pathlib.Path(schema_path).read_bytes()).hexdigest(),
        "caseCount": len(corpus()),
        "cases": report,
    }
    pathlib.Path(sys.argv[5]).write_text(json.dumps(output, sort_keys=True, indent=2) + "\n")
else:
    unittest.main(argv=[sys.argv[0]], verbosity=2)
PY
