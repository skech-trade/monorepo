//! The program's ladder against `@skech/core`'s, row for row (`vectors/ladder.ts` prints them).

#[test]
fn the_ladder_is_the_same_integers_as_the_app_and_monad() {
    let rows: Vec<(u32, u8, bool, i64, u16)> = serde_json::from_str(include_str!("../vectors/ladder.json")).unwrap();
    assert!(rows.len() > 10_000);
    for (chance, d, with_it, momentum, want) in rows {
        assert_eq!(skech::ladder::rung_for(chance, d, with_it, momentum), want, "chance {chance}, difficulty {d}, with it {with_it}, momentum {momentum}");
    }
}
