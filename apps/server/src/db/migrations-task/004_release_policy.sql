-- 给 bootstrap_resources 加 release_policy 列(prepare 时写,release 时读)。
-- 新增的列允许 NULL 兼容历史 row;runner 读到 NULL 视为 'remove-if-clean'(schema 默认)。

ALTER TABLE bootstrap_resources ADD COLUMN release_policy TEXT
  CHECK(release_policy IS NULL OR release_policy IN ('retain','remove-if-clean','prompt','archive'));
