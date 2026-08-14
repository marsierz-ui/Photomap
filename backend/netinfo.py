"""Work out which addresses other devices can reach this server on."""
import os
import socket


def lan_ips() -> list[str]:
    """Reachable IPv4 addresses, best guess first.

    Machines with WSL, Hyper-V or a VPN have several adapters, and only one of
    them is the one a phone on the same Wi-Fi can reach. The address the OS picks
    to route outbound traffic is that one, so it goes first.
    """
    ordered: list[str] = []

    def add(ip: str) -> None:
        if ip and not ip.startswith(("127.", "169.254.")) and ip not in ordered:
            ordered.append(ip)

    # Connecting a UDP socket only sets a route; no packets are sent.
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("203.0.113.1", 9))
        add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except socket.gaierror:
        pass

    return ordered


def port() -> int:
    return int(os.environ.get("PHOTOMAP_PORT", 8712))


def share_urls(key: str | None = None) -> list[str]:
    suffix = f"/?k={key}" if key else "/"
    return [f"http://{ip}:{port()}{suffix}" for ip in lan_ips()]
