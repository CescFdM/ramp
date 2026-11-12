"""state.json -> data.json (what the website decrypts)."""
from common import assemble, load_state, save_data

if __name__ == "__main__":
    data = assemble(load_state())
    save_data(data)
    print(f"[assemble] {len(data['activities'])} activities, {len(data['daily'])} wellness days, plan={'yes' if data['plan'] else 'no'}")
