def find_user(uid):
    return cursor.execute(f"SELECT * FROM t WHERE id = %s" % uid)
