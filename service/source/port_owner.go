package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

type listenerEndpoint struct {
	IP      net.IP
	Port    int
	Network string
}

type portOwner struct {
	PID              int
	ExecutablePath   string
	CreationIdentity string
	Endpoint         listenerEndpoint
}

func servicePortOwner(address string) (portOwner, bool, error) {
	endpoint, err := exactListenerEndpoint(address)
	if err != nil {
		return portOwner{}, false, err
	}
	pid, err := processIDForEndpoint(endpoint)
	if err != nil {
		return portOwner{}, false, err
	}
	if pid == 0 {
		return portOwner{}, false, nil
	}
	executablePath, creationIdentity, _ := processIdentityByPID(pid)
	return portOwner{
		PID:              pid,
		ExecutablePath:   executablePath,
		CreationIdentity: creationIdentity,
		Endpoint:         endpoint,
	}, true, nil
}

func exactListenerEndpoint(address string) (listenerEndpoint, error) {
	host, portString, err := net.SplitHostPort(address)
	if err != nil {
		return listenerEndpoint{}, err
	}
	port, err := strconv.Atoi(portString)
	if err != nil || port < 1 || port > 65535 {
		return listenerEndpoint{}, fmt.Errorf("invalid port in %q", address)
	}
	host = strings.TrimSpace(host)
	if strings.EqualFold(host, "localhost") {
		return listenerEndpoint{}, fmt.Errorf("listener address %q must use an exact loopback IP, not localhost", address)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return listenerEndpoint{}, fmt.Errorf("listener address %q must use an exact loopback IP", address)
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return listenerEndpoint{IP: append(net.IP(nil), ipv4...), Port: port, Network: "tcp4"}, nil
	}
	return listenerEndpoint{IP: append(net.IP(nil), ip.To16()...), Port: port, Network: "tcp6"}, nil
}

func (endpoint listenerEndpoint) String() string {
	if endpoint.IP == nil || endpoint.Port == 0 {
		return ""
	}
	return net.JoinHostPort(endpoint.IP.String(), strconv.Itoa(endpoint.Port)) + "/" + endpoint.Network
}

func (endpoint listenerEndpoint) Address() string {
	if endpoint.IP == nil || endpoint.Port == 0 {
		return ""
	}
	return net.JoinHostPort(endpoint.IP.String(), strconv.Itoa(endpoint.Port))
}

func sameListenerEndpoint(left, right listenerEndpoint) bool {
	return left.Port == right.Port && left.Network == right.Network && left.IP != nil && right.IP != nil && left.IP.Equal(right.IP)
}

func currentExecutablePath() (string, error) {
	return os.Executable()
}

func sameExecutableFile(leftPath, rightPath string) bool {
	leftInfo, leftErr := os.Stat(leftPath)
	rightInfo, rightErr := os.Stat(rightPath)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return os.SameFile(leftInfo, rightInfo)
}
