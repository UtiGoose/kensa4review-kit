class Sample {
  @Transactional
  public void tx() {
    // ruleid: rk-java-transactional-external-call
    client.models.generateContent("m", x, cfg);
  }

  public void noTx() {
    // ok: rk-java-transactional-external-call
    client.models.generateContent("m", x, cfg);
  }

  void loops() {
    // ruleid: rk-java-unbounded-find-all
    var a = repository.findAll().stream().map(f -> f.id()).toList();
    // ruleid: rk-java-repository-in-loop
    var b = items.stream().map(i -> repository.findById(i)).toList();
    for (var i : items) {
      // ruleid: rk-java-repository-in-loop
      this.repository.deleteById(i);
    }
    // ok: rk-java-repository-in-loop
    var c = repository.findAll(q).map(this::toDto);
  }

  void sql() {
    // ruleid: rk-java-sql-concat
    jdbcTemplate.query("select * from t where a = " + a, mapper);
    // ok: rk-java-sql-concat
    jdbcTemplate.query("select * " + "from t", mapper);
    // ok: rk-java-sql-concat
    executor.execute("import:" + path, id);
    // ruleid: rk-jooq-plain-sql-concat
    DSL.condition("a = " + value);
  }

  void logs() {
    // ok: rk-java-log-sensitive
    log.warn("x {}", token.getUserId());
    // ruleid: rk-java-log-sensitive
    log.warn("x {}", user.getPassword());
    // ruleid: rk-java-print-stack-trace
    e.printStackTrace();
  }

  void security() {
    // ruleid: rk-spring-permit-all-wildcard
    http.authorizeHttpRequests(a -> a.anyRequest().permitAll());
    // ruleid: rk-jwt-unsigned
    parser.parseUnsecuredClaims(t);
  }
}
